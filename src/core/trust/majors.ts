// Deprecated majors per context: the retire date, and what a caller sees (nothing, a warning, or a rejection).
// Follows design section 8 §11.9 and section 3 §4.8 (check 4), §5.9 (the warning). Lazy by owner default:
// a retired major writes no history lines; the pre-run check reads the major record each time.
import type { ScoreStore } from "../../ports/scores.js";
import type { DocumentStore } from "../../ports/stores.js";
import type { LiveLine } from "../model/live-line.js";
import type { Major } from "../model/major.js";
import type { HistoryLine } from "../model/score-history.js";
import type { ScoreRecord } from "../model/score.js";
import { capabilityParts, keyPath, parseKeyPath } from "./keys.js";

/** Days after the successor's first approval before the old major retires here (section 8 §11.9). */
export const GRACE_DAYS = 90;
const DAY_MS = 86_400_000;

/** What one context knows about a deprecated major. `retiresOn` is `null` while the successor is not approved here. */
export type MajorStatus = {
  /** The record's capability and major, like `kvfcu/open_share_subaccount@1`. */
  name: string;
  successor: number;
  /** This context's retire day (`YYYY-MM-DD`), or `null`: the successor does not run here yet. */
  retiresOn: string | null;
};

/** `ms` (epoch milliseconds) as a `YYYY-MM-DD` UTC date. Why `Intl`: no `Date` object in core (CLAUDE.md). */
function dayOf(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(ms);
}

/**
 * The retire day in one context: the later of `retires_on` and 90 days after the successor's first
 * approval here. `null` when the successor was never approved here (section 8 §11.9: never tell a
 * caller to move to a major that does not yet run at its bank).
 */
export function retireDate(record: Pick<Major, "retires_on">, successorFirstApproval: string | null): string | null {
  if (successorFirstApproval === null) return null;
  const after = dayOf(Date.parse(successorFirstApproval) + GRACE_DAYS * DAY_MS);
  return after > record.retires_on ? after : record.retires_on;
}

/** What the caller sees, on a UTC day `today`: nothing, a warning, or a rejection (section 8 §11.9 table). */
export type MajorVerdict =
  | { kind: "none" }
  | { kind: "warn"; message: string }
  | { kind: "retired"; message: string };

/** The verdict for a status. The messages name the date and the successor. */
export function majorVerdict(status: MajorStatus | null, today: string): MajorVerdict {
  if (status === null || status.retiresOn === null) return { kind: "none" };
  const [name = ""] = status.name.split("@");
  const major = capabilityMajorText(status.name);
  const successor = `${name}@${String(status.successor)}`;
  return today >= status.retiresOn
    ? { kind: "retired", message: `${name}@${major} retired on ${status.retiresOn} for this bank. Move to ${successor}.` }
    : { kind: "warn", message: `Major version ${major} retires on ${status.retiresOn}. Move to @${String(status.successor)}.` };
}

/** The major of a name like `kvfcu/open_share_subaccount@1`. */
function capabilityMajorText(name: string): string {
  return name.slice(name.indexOf("@") + 1);
}

/** The ports the major status needs. */
export type MajorDeps = {
  majors: DocumentStore<Major>;
  scores: ScoreStore<HistoryLine, ScoreRecord, LiveLine>;
};

/** The newest approved record of a major, or `null`. A record that cannot be read counts as none: the caller is never blocked by a bad file. */
async function approvedRecord(deps: MajorDeps, id: string): Promise<Major | null> {
  const all = await deps.majors.list({ id });
  const rev = all.filter((s) => s.state === "approved").sort((a, b) => Number(a.rev) - Number(b.rev)).at(-1)?.rev;
  if (rev === undefined) return null;
  const got = await deps.majors.get(id, rev);
  return got.ok ? got.value.doc : null;
}

/**
 * The status of `<app>/<capability>@<major>` for one tenant: `null` when no approved record deprecates it.
 * The successor's first approval is the earliest `approved` history line among the tenant's keys of the
 * successor major (on `appVersion`, when given): that is "approved here".
 */
export async function majorStatus(
  deps: MajorDeps,
  tenant: string,
  appVersion: string | undefined,
  app: string,
  capability: string,
  major: number,
): Promise<MajorStatus | null> {
  const record = await approvedRecord(deps, `${app}/${capability}@${String(major)}`);
  if (record === null) return null;
  let first: string | null = null;
  for (const path of await deps.scores.paths(tenant)) {
    const key = parseKeyPath(path);
    if (key === null || key.patch_revision !== null) continue;
    const parts = capabilityParts(key.capability);
    if (parts.name !== `${app}/${capability}` || parts.major !== record.successor) continue;
    if (appVersion !== undefined && key.app_version !== appVersion) continue;
    const lines = await deps.scores.history(keyPath(key));
    if (!lines.ok) continue;
    const at = lines.value.find((l) => l.event === "approved")?.at;
    if (at !== undefined && (first === null || at < first)) first = at;
  }
  return { name: `${app}/${capability}@${String(major)}`, successor: record.successor, retiresOn: retireDate(record, first) };
}
