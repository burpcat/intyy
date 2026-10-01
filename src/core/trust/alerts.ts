// Alert writes: the drift reader's findings become alert files, and staff close them.
// Follows design section 8 §13.1 (the reader runs after every score write), §5.3 (the record lists
// open alert ids), and section 9 §9.7 (`alert act`, `alert dismiss`). Core code: ports only.
import type { Clock, Ids } from "../../ports/clock.js";
import type { AlertStore } from "../../ports/alerts.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import { Alert } from "../model/alert.js";
import { Artifact } from "../model/artifact.js";
import type { ScoreKey } from "../model/score.js";
import { allFindings, type Finding, type KeyFacts } from "./drift.js";
import { keyPath, keyText } from "./keys.js";
import { rebuild } from "./rebuild.js";
import { hashesFor, listKeys, rebuildKey, type ScoreDeps, type ScoreWriter } from "./scores.js";

/** What alert code needs: the score ports, the alert store, the clock, and IDs. */
export type DriftDeps = ScoreDeps & { alerts: AlertStore<Alert>; clock: Clock; ids: Ids };

/** The step timeouts in force: the sealed artifact's, with the record's approved (tuned) values on top. */
async function timeoutsOf(deps: ScoreDeps, key: ScoreKey, tuned: Readonly<Record<string, number>>): Promise<Record<string, number>> {
  const at = key.capability.indexOf("@");
  const sealed = await deps.artifacts.getSealedArtifact(key.capability.slice(0, at), key.capability.slice(at + 1));
  const parsed = sealed.ok ? Artifact.safeParse(sealed.value) : null;
  const out: Record<string, number> = {};
  if (parsed?.success === true) for (const s of parsed.data.steps) out[s.id] = s.timeout_ms;
  return { ...out, ...tuned };
}

/**
 * Reads every key of these tenants that has score files: history, live lines, and a record rebuilt
 * from them. A key whose files cannot be read, or whose history breaks the rules, is left out: the
 * drift reader is advice and must not stop on one bad key (`trust rebuild` reports it).
 */
export async function gatherFacts(deps: ScoreDeps, tenants: readonly string[]): Promise<KeyFacts[]> {
  const out: KeyFacts[] = [];
  for (const tenant of tenants) {
    for (const key of (await listKeys(deps.scores, tenant)).keys) {
      const path = keyPath(key);
      const history = await deps.scores.history(path);
      const live = await deps.scores.liveLines(path);
      if (!history.ok || !live.ok) continue;
      const record = rebuild(key, await hashesFor(deps.artifacts, key), history.value, live.value);
      if (!record.ok) continue;
      const timeouts = await timeoutsOf(deps, key, record.value.timeouts.approved);
      out.push({ key, record: record.value, history: history.value, live: live.value, timeouts });
    }
  }
  return out;
}

/**
 * True when the finding adds something: no open alert has its fingerprint, and a closed one with the
 * same fingerprint did not already list all of its runs. Why: a dismissed alert stays quiet until
 * new evidence arrives (section 8 §13.1).
 */
export function isNewFinding(existing: readonly Alert[], f: Finding): boolean {
  const same = existing.filter((a) => a.fingerprint === f.fingerprint && a.tenant === f.tenant);
  if (same.some((a) => a.state === "open")) return false;
  const covered = new Set(same.flatMap((a) => a.evidence_runs));
  return same.length === 0 || f.runs.some((r) => !covered.has(r));
}

/** Rebuilds the records of the named keys, so each lists its open alerts (section 8 §5.3). A busy lock is skipped: the next write picks it up. */
export async function refreshAlerts(deps: ScoreDeps, tenant: string, keys: readonly string[], who: ScoreWriter): Promise<void> {
  for (const key of (await listKeys(deps.scores, tenant)).keys) {
    if (keys.includes(keyText(key))) await rebuildKey(deps, key, who);
  }
}

/** Writes one alert. Returns it, or the failed write. */
async function raise(
  deps: DriftDeps,
  from: { tenant: string; keys: string[]; pattern: Alert["pattern"]; runs: string[]; detail: string; fix: string; fingerprint: string },
): Promise<Outcome<Alert, "write_failed">> {
  const alert: Alert = {
    schema: "intyy.alert/1.0",
    id: deps.ids.alertId(),
    tenant: from.tenant,
    at: deps.clock.now().toISOString(),
    keys: from.keys,
    pattern: from.pattern,
    detail: from.detail,
    fingerprint: from.fingerprint,
    evidence_runs: from.runs,
    suggested_fix: from.fix,
    state: "open",
    closed: null,
  };
  const put = await deps.alerts.put(alert.id, alert);
  if (!put.ok) return put;
  await refreshAlerts(deps, from.tenant, from.keys, { owner: alert.id, command: "drift", staff: null });
  return ok(alert);
}

/**
 * Runs the drift reader over these tenants and writes an alert for each new finding. This runs after
 * every score write (section 8 §13.1). Returns the alerts it wrote. It reads all keys each time:
 * ponytail: fine for a few dozen keys, so cache per-key results if a tenant grows past that.
 */
export async function scanDrift(deps: DriftDeps, tenants: readonly string[]): Promise<Outcome<Alert[], "write_failed" | "invalid">> {
  const listed = await deps.alerts.list();
  if (!listed.ok) return listed;
  const existing = [...listed.value];
  const wrote: Alert[] = [];
  for (const f of allFindings(await gatherFacts(deps, tenants))) {
    if (!isNewFinding(existing, f)) continue;
    const made = await raise(deps, f);
    if (!made.ok) return made;
    existing.push(made.value);
    wrote.push(made.value);
  }
  return ok(wrote);
}

/** The alert for a live line that could not be written (section 8 §5.6: a failed score write writes an alert). */
export async function raiseLiveWriteFailed(
  deps: DriftDeps,
  failure: { tenant: string; key: string; runId: string; reason: string },
): Promise<Outcome<Alert, "write_failed">> {
  return raise(deps, {
    tenant: failure.tenant,
    keys: [failure.key],
    pattern: "live_write_failed",
    runs: [failure.runId],
    detail: `The live line of run ${failure.runId} could not be written: ${failure.reason}`,
    fix: `Run: intyy trust rebuild ${failure.key} --from-evidence`,
    fingerprint: `live_write_failed:${failure.key}:${failure.runId}`,
  });
}

/** Why closing an alert failed. */
export type CloseFailure = "not_found" | "invalid" | "not_open" | "write_failed";

/**
 * Marks an open alert `acted` or `dismissed`, with who, when, and the note (what was done, or why not).
 * Section 9 §9.7. Then the records of its keys are rebuilt so they stop listing it.
 */
export async function closeAlert(
  deps: DriftDeps,
  id: string,
  as: "acted" | "dismissed",
  by: string,
  note: string,
): Promise<Outcome<Alert, CloseFailure>> {
  const found = await deps.alerts.get(id);
  if (!found.ok) return found;
  if (found.value.state !== "open") return fail("not_open", `alert ${id} is already ${found.value.state}`);
  const closed: Alert = { ...found.value, state: as, closed: { by, at: deps.clock.now().toISOString(), note } };
  const put = await deps.alerts.put(id, closed);
  if (!put.ok) return put;
  await refreshAlerts(deps, closed.tenant, closed.keys, { owner: id, command: `alert ${as === "acted" ? "act" : "dismiss"}`, staff: by });
  return ok(closed);
}
