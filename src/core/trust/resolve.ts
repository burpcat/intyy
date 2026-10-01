// The resolver's key choice: which sealed version a run uses in one context, by fixed rules.
// Pure functions over score records; `loadRecords` is the one read through the score port.
// Follows design section 8 §11 (resolver): §11.2 candidates, §11.3 unattended, §11.4 supervised,
// §11.7 links, and §10.10 (linked capabilities).
import type { ScoreStore } from "../../ports/scores.js";
import { compareSemver } from "../catalog/artifacts.js";
import type { Artifact } from "../model/artifact.js";
import type { Mode } from "../model/request.js";
import type { LiveLine } from "../model/live-line.js";
import type { HistoryLine } from "../model/score-history.js";
import type { ScoreRecord, TrustState } from "../model/score.js";
import { capabilityParts } from "./keys.js";

/** The context a key is chosen in: the tenant, the bank's app version, and the capability at one major. */
export type Scope = {
  tenant: string;
  appVersion: string;
  /** `<app>/<capability>`. */
  name: string;
  major: number;
  records: readonly ScoreRecord[];
};

/**
 * What the resolver chose. `none`: unattended, no approved key (`reason` says why, section 8 §11.3).
 * `blocked`: supervised, but every sealed version's latest batch had a `wrong` verdict.
 */
export type PickResult =
  | { kind: "key"; artifact: Artifact; record: ScoreRecord | null }
  | { kind: "none"; reason: "not_approved" | "degraded" }
  | { kind: "blocked" };

/** The exact capability text of a sealed artifact, like `kvfcu/sign_in@1.0.0`. */
function capabilityOf(a: Artifact): string {
  return `${a.identity.app}/${a.identity.capability}@${a.identity.version ?? "0.0.0"}`;
}

/** The "no patch" record of one sealed version in this context, or `null` (no record means draft, section 8 §5.2). */
export function recordFor(
  records: readonly ScoreRecord[],
  tenant: string,
  appVersion: string,
  artifact: Artifact,
): ScoreRecord | null {
  const cap = capabilityOf(artifact);
  return (
    records.find(
      (r) =>
        r.key.capability === cap &&
        r.key.tenant === tenant &&
        r.key.app_version === appVersion &&
        r.key.patch_revision === null,
    ) ?? null
  );
}

/** Newest first: highest version by semver (section 8 §11.4). "No patch" is the only patch here, so it needs no tie-break. */
function newestFirst<T extends { artifact: Artifact }>(rows: T[]): T[] {
  return rows.sort((a, b) => compareSemver(b.artifact.identity.version ?? "0.0.0", a.artifact.identity.version ?? "0.0.0"));
}

/** Why no key is approved: `degraded` when the latest key ever approved is degraded, else `not_approved` (section 8 §11.3). */
function noneReason(s: Scope): "not_approved" | "degraded" {
  const ever = s.records
    .filter((r) => {
      const p = capabilityParts(r.key.capability);
      return r.key.tenant === s.tenant && r.key.app_version === s.appVersion && p.name === s.name && p.major === s.major && r.approval !== null;
    })
    .sort((a, b) => (a.approval?.at ?? "") < (b.approval?.at ?? "") ? 1 : -1);
  return ever[0]?.state === "degraded" ? "degraded" : "not_approved";
}

/**
 * Chooses the key for one capability in one context. `fitting` holds the sealed versions of the
 * major whose `runs_on.app_versions` fit the bank's app version (section 8 §11.2).
 * Unattended picks the one approved key (§11.3). Supervised takes the first rule that finds one (§11.4):
 * the approved key, the newest certified key, the newest sealed key without a `wrong` verdict.
 * Retired keys are never candidates here; only a pin reaches one. Patch keys wait for a patch store.
 */
export function pickKey(mode: Mode, scope: Scope, fitting: readonly Artifact[]): PickResult {
  const rows = newestFirst(
    fitting.map((artifact) => ({ artifact, record: recordFor(scope.records, scope.tenant, scope.appVersion, artifact) })),
  ).filter((x) => x.record?.state !== "retired");
  const approved = rows.find((x) => x.record?.state === "approved");
  if (approved !== undefined) return { kind: "key", ...approved };
  if (mode === "unattended") return { kind: "none", reason: noneReason(scope) };
  const certified = rows.find((x) => x.record?.certify?.gate === "passed");
  if (certified !== undefined) return { kind: "key", ...certified };
  // Why: section 8 §11.4. A recipe that lied about data cannot be watched by a human at the start.
  const clean = rows.find((x) => (x.record?.certify?.scores?.verdicts.wrong ?? 0) === 0);
  return clean === undefined ? { kind: "blocked" } : { kind: "key", ...clean };
}

/**
 * A capability's state in one context, for `capability list`: `approved` if any key of the major is,
 * else `degraded`, else `retired`, else `draft` (no record, or only drafts).
 */
export function contextState(
  records: readonly ScoreRecord[],
  tenant: string,
  appVersion: string | undefined,
  name: string,
  major: number,
): TrustState {
  const mine = records.filter((r) => {
    const p = capabilityParts(r.key.capability);
    return r.key.tenant === tenant && (appVersion === undefined || r.key.app_version === appVersion) && p.name === name && p.major === major;
  });
  for (const state of ["approved", "degraded", "retired"] as const) {
    if (mine.some((r) => r.state === state)) return state;
  }
  return "draft";
}

/**
 * Every record of the tenant, read from `record.json`. A key whose record is missing or unreadable
 * is left out, so it counts as a draft and no unattended run uses it (fail closed). `trust rebuild` repairs it.
 */
export async function loadRecords(
  scores: ScoreStore<HistoryLine, ScoreRecord, LiveLine>,
  tenant: string,
  signal?: AbortSignal,
): Promise<ScoreRecord[]> {
  const out: ScoreRecord[] = [];
  for (const path of await scores.paths(tenant, signal)) {
    const got = await scores.getRecord(path, signal);
    if (got.ok) out.push(got.value);
  }
  return out;
}
