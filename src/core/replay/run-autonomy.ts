// What one replay run needs for reconciliation autonomy: the scope it runs under, and the
// revocation it makes when a live check or a human disagrees with jev.
// Follows design section 8 §14.2 (scope; revoked when a live spot check or a human disagrees) and section 5 §10.6.
import type { Artifact } from "../model/artifact.js";
import type { Autonomy, AutonomyScope } from "../model/score.js";
import type { ArtifactStore } from "../catalog/artifacts.js";
import { resolveMajor } from "../catalog/capabilities.js";
import { sameScope } from "../trust/autonomy.js";
import { revokeAutonomy } from "../trust/decisions.js";
import { keyText } from "../trust/keys.js";
import type { ReplayDeps, ReplayInput } from "./executor.js";
import { keyOf, scoreDepsOf, tell } from "./live-hook.js";
import { splitCapabilityLink } from "./reconciliation.js";

/**
 * The scope this run's reconciliation would run under (section 8 §14.2): the exact check key the
 * artifact's link resolves to, and the jev version the engine holds. `check` is `null` when the
 * artifact has no check, or the link does not resolve. `jev` is `null` when no jev version is wired.
 */
export async function runScope(deps: ReplayDeps, input: ReplayInput, artifact: Artifact | null): Promise<AutonomyScope> {
  return { check: await checkKeyOf(deps.artifacts, artifact, input.appVersion), check_patch: null, jev: deps.models?.jevVersion ?? null };
}

/** The exact check key an artifact's reconciliation link resolves to for an app version, like `kvfcu/find_account@1.0.0`, or `null`. */
export async function checkKeyOf(store: ArtifactStore, artifact: Artifact | null, appVersion: string | undefined): Promise<string | null> {
  const link = artifact?.recovery?.reconciliation?.check?.capability;
  if (link === undefined) return null;
  const l = splitCapabilityLink(link);
  const got = await resolveMajor(store, l.app, l.capability, l.major, appVersion);
  const version = got.ok ? got.value.identity.version : null;
  return version === null ? null : `${l.app}/${l.capability}@${version}`;
}

/**
 * Revokes the key's autonomy from a live run (section 8 §14.2: a spot check or a human disagrees).
 * Acts only when the run's record held autonomy for the run's own scope: evidence about another
 * check key or jev version is not this run's to take away. Never throws, never changes the run's
 * result; a failed write is told through `onLiveFailure`. Returns true when a revocation was written.
 */
export async function revokeFromRun(
  deps: ReplayDeps,
  input: ReplayInput,
  run: { runId: string; artifact: Artifact; scope: AutonomyScope; held: Autonomy | null },
  reason: string,
): Promise<boolean> {
  const trust = scoreDepsOf(deps);
  const key = keyOf(run.artifact, input);
  const held = run.held;
  if (trust === null || key === null || held === null || held.state === "revoked" || !sameScope(held, run.scope)) return false;
  try {
    const done = await revokeAutonomy(trust, key, {
      by: "system",
      reason,
      runs: [run.runId],
      at: deps.clock.now(),
      who: { owner: run.runId, command: "replay", staff: input.staffId ?? null },
      ...(deps.alerts === undefined ? {} : { alert: { ...trust, alerts: deps.alerts, clock: deps.clock, ids: deps.ids } }),
    });
    if (!done.ok && done.failure !== "no_autonomy") {
      await tell(deps, { key: keyText(key), runId: run.runId, reason: `autonomy revoke: ${done.detail ?? done.failure}` });
    }
    return done.ok;
  } catch (e) {
    await tell(deps, { key: keyText(key), runId: run.runId, reason: e instanceof Error ? e.message : String(e) });
    return false;
  }
}
