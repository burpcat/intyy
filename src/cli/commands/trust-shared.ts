// Helpers every `trust` command shares: the score ports, key text, the current record, and who is asking.
// Follows design section 9 §9.4 and §9.8; section 8 §5.2 (no record file means draft), §10.1 (roles).
import type { ScoreKey, ScoreRecord } from "../../core/model/score.js";
import { Role, hasRole } from "../../core/model/staff.js";
import { scanDrift, type DriftDeps } from "../../core/trust/alerts.js";
import type { DecisionFailure } from "../../core/trust/decisions.js";
import { keyPath, parseKeyText } from "../../core/trust/keys.js";
import { rebuild } from "../../core/trust/rebuild.js";
import { hashesFor, listKeys, openAlertIds, type ScoreDeps } from "../../core/trust/scores.js";
import { readStaff, type Ctx } from "../context.js";
import { CliExit, EXIT, type ExitCode } from "../exit-codes.js";
import { load } from "./documents.js";
import { settingsTarget } from "./settings.js";

/** The exit code for a score write or a staff decision that failed. A refusal by a rule is 6 (section 9 §7.5). */
export function exitFor(failure: DecisionFailure): ExitCode {
  switch (failure) {
    case "busy":
      return EXIT.busy;
    case "write_failed":
    case "unknown_run":
      return EXIT.usage;
    case "role":
    case "illegal_move":
    case "needs_staff":
    case "no_exclusion":
    case "rule_still_fires":
    case "not_ready":
    case "no_autonomy":
      return EXIT.refused;
    default:
      return EXIT.invalid;
  }
}

/** The tenants the drift reader compares: every tenant with settings, and this one (section 8 §13.2 compares tenants). */
export async function driftTenants(ctx: Ctx): Promise<string[]> {
  const listed = await ctx.wiring.settings.list({});
  return [...new Set([ctx.tenant, ...listed.map((d) => d.id)])].sort();
}

/** The ports the drift reader and alert commands use, from the wiring. */
export function driftDeps(ctx: Ctx): DriftDeps {
  const { scores, locks, alerts, clock, ids } = ctx.wiring;
  return { scores, locks, artifacts: ctx.wiring.candidates, alerts, clock, ids };
}

/**
 * The ports score code uses, from the wiring. Every history or live write then runs the drift
 * reader once the write is done (section 8 §13.1), and a rebuilt record lists its open alerts.
 */
export function scoreDeps(ctx: Ctx): ScoreDeps {
  return {
    scores: ctx.wiring.scores,
    locks: ctx.wiring.locks,
    artifacts: ctx.wiring.candidates,
    alerts: ctx.wiring.alerts,
    afterWrite: async () => {
      await scanDrift(driftDeps(ctx), await driftTenants(ctx));
    },
  };
}

/** Reads `<key>` text into a key: the tenant is `--tenant`, the app version comes from the tenant's approved settings. */
export async function keyFromText(ctx: Ctx, text: string | undefined): Promise<ScoreKey> {
  const app = /^([a-z][a-z0-9_-]*)\//.exec(text ?? "")?.[1];
  if (app === undefined) throw new CliExit(EXIT.usage, "name a key, like kvfcu/open_share_subaccount@1.0.0");
  const settings = await load(settingsTarget(ctx), ["approved"]);
  if (!settings) throw new CliExit(EXIT.invalid, `settings ${ctx.tenant} have no approved revision`);
  const appVersion = settings.doc.apps[app]?.app_version;
  if (appVersion === undefined) throw new CliExit(EXIT.usage, `${app} has no settings for tenant ${ctx.tenant}`);
  const key = parseKeyText(text ?? "", ctx.tenant, appVersion);
  if (!key.ok) throw new CliExit(EXIT.usage, key.detail ?? key.failure);
  return key.value;
}

/**
 * The key's record now: `record.json` when it reads, else rebuilt from the history. A key with no
 * files is the synthetic draft (section 8 §5.2). Readers never lock. Why a rebuild and not an
 * error: `trust rebuild` is the repair, and a reader should still show the truth the lines hold.
 */
export async function currentRecord(deps: ScoreDeps, key: ScoreKey): Promise<ScoreRecord> {
  const path = keyPath(key);
  const file = await deps.scores.getRecord(path);
  if (file.ok) return file.value;
  const lines = await deps.scores.history(path);
  if (!lines.ok) throw new CliExit(EXIT.invalid, `${path}: ${lines.detail ?? lines.failure}`);
  // Why the live lines too: a missing record must still show the key's live score (section 8 §5.2).
  const live = await deps.scores.liveLines(path);
  if (!live.ok) throw new CliExit(EXIT.invalid, `${path}: ${live.detail ?? live.failure}`);
  const rebuilt = rebuild(key, await hashesFor(deps.artifacts, key), lines.value, live.value, await openAlertIds(deps, key));
  if (!rebuilt.ok) throw new CliExit(EXIT.invalid, `${path}: ${rebuilt.detail ?? rebuilt.failure}`);
  return rebuilt.value;
}

/** Every record of the tenant's keys that have score files. */
export async function tenantRecords(ctx: Ctx, deps: ScoreDeps): Promise<ScoreRecord[]> {
  const { keys } = await listKeys(deps.scores, ctx.tenant);
  return Promise.all(keys.map((k) => currentRecord(deps, k)));
}

/** The staff ID and the roles it holds for this tenant, or `null` when no staff ID is set (section 9 §7.7). */
export function whoIs(ctx: Ctx): { staff: string; roles: Role[] } | null {
  if (ctx.staff === null) return null;
  const file = readStaff(ctx);
  const staff = ctx.staff;
  return { staff, roles: Role.options.filter((r) => hasRole(file, staff, ctx.tenant, r)) };
}
