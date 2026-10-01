// The live hook: after a replay run ends, write its live lines and check the demotion rules.
// Follows design section 8 §5.5 and §5.6 (replay, after `run_end`, writes live lines for the task,
// session, and check keys) and §12.1 (certify runs never count). A write failure never changes the
// run's result: the hook reports it through `onLiveFailure` and returns.
import type { Artifact } from "../model/artifact.js";
import type { LiveLine } from "../model/live-line.js";
import type { Result } from "../model/result.js";
import type { ScoreKey } from "../model/score.js";
import { keyText } from "../trust/keys.js";
import { liveLinesOf } from "../trust/live-class.js";
import { recordLive, type ScoreDeps } from "../trust/scores.js";
import type { ReplayDeps, ReplayInput } from "./executor.js";

/** The key an artifact's runs score under, or `null` when it has no version or the tenant has no app version. */
export function keyOf(a: Artifact | null, input: ReplayInput): ScoreKey | null {
  if (a?.identity.version == null || input.appVersion === undefined) return null;
  return {
    capability: `${a.identity.app}/${a.identity.capability}@${a.identity.version}`,
    tenant: input.tenant,
    app_version: input.appVersion,
    patch_revision: null,
  };
}

/** The score ports of a replay's deps, or `null` when it has no score store or locks. */
export function scoreDepsOf(deps: ReplayDeps): ScoreDeps | null {
  if (deps.scores === undefined || deps.locks === undefined) return null;
  return {
    scores: deps.scores,
    locks: deps.locks,
    artifacts: deps.artifacts,
    ...(deps.alerts === undefined ? {} : { alerts: deps.alerts }),
    ...(deps.afterScoreWrite === undefined ? {} : { afterWrite: deps.afterScoreWrite }),
  };
}

/** Tells `onLiveFailure`. Why the catch: a failing alert write must not change the run's result (section 8 §5.6). */
export async function tell(deps: ReplayDeps, failure: { key: string; runId: string; reason: string }): Promise<void> {
  try {
    await deps.onLiveFailure?.(failure);
  } catch {
    // The run's result stands; `trust rebuild --from-evidence` repairs the live line.
  }
}

/**
 * Writes the live lines of one finished replay run, then lets the rules degrade a key. Never throws
 * for a failed write and never changes `result`: `onLiveFailure` hears about each one, and
 * `trust rebuild --from-evidence` repairs the lines from `run.json` (section 8 §5.6).
 * Writes nothing for a certify run (section 8 §5.5), a commit-retry child (its parent's result
 * covers the request), a run with no resolved artifact, or a deps bundle with no score store or locks.
 */
export async function writeLiveLines(
  deps: ReplayDeps,
  input: ReplayInput,
  run: { runId: string; result: Result; artifact: Artifact | null; session: Artifact | null; handlerSet: string; handlerPacks: Readonly<Record<string, number>> },
): Promise<void> {
  if (deps.scores === undefined || deps.locks === undefined) return;
  if (input.batchId != null || input.purpose === "commit_retry") return;
  const taskKey = keyOf(run.artifact, input);
  if (taskKey === null) return;
  const events = await deps.evidence.events(input.tenant, run.runId, deps.signal);
  const lines = liveLinesOf({
    runId: run.runId,
    at: deps.clock.now().toISOString(),
    mode: input.request.mode,
    kind: input.kind ?? "replay",
    result: run.result,
    events: events.ok ? events.value : [],
    under: {
      engine: input.engineVersion,
      handler_set: run.handlerSet,
      jev: null,
      ...(Object.keys(run.handlerPacks).length === 0 ? {} : { packs: { ...run.handlerPacks } }),
    },
  });
  const trust = scoreDepsOf(deps);
  if (trust === null) return;
  const who = { owner: run.runId, command: "replay", staff: input.staffId ?? null };
  const writes: [ScoreKey | null, LiveLine | null][] = [
    [taskKey, lines.main],
    [keyOf(run.session, input), lines.prelude],
  ];
  for (const [key, line] of writes) {
    if (key === null || line === null) continue;
    try {
      const done = await recordLive(trust, key, line, who, deps.clock.now());
      if (!done.ok) await tell(deps, { key: keyText(key), runId: run.runId, reason: done.detail ?? done.failure });
    } catch (e) {
      await tell(deps, { key: keyText(key), runId: run.runId, reason: e instanceof Error ? e.message : String(e) });
    }
  }
}
