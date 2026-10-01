// Shared builders for the live-trust tests: hand-built live lines, results, run-log events, and one
// world of fakes (score store, locks, clock). Not a test file.
// Design section 8 §5.5 (live lines), §5.6 (writers and locks), §12.1 to §12.3. M11 tasks 1 and 2.
import type { LiveLine } from "../../../src/core/model/live-line.js";
import { Result } from "../../../src/core/model/result.js";
import type { HistoryLine } from "../../../src/core/model/score-history.js";
import type { ScoreRecord } from "../../../src/core/model/score.js";
import { LockManager } from "../../../src/core/locks/manager.js";
import type { SealedArtifacts } from "../../../src/core/trust/scores.js";
import { HistoryLine as HistoryLineSchema } from "../../../src/core/model/score-history.js";
import { ScoreRecord as ScoreRecordSchema } from "../../../src/core/model/score.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { MemoryLockSlots } from "../../../src/fakes/locks.js";
import { FakeScoreStore } from "../../../src/fakes/score-store.js";
import { h } from "./kit.js";

/** A made-up run ID. `n` is 0 to 99; the suffix is ten characters from the ID alphabet. */
export const runId = (n: number): string => `run_2026-01-15_${String(n).padStart(10, "0")}`;

/** An ISO time `minute` minutes after 10:00 on 2026-01-15. Later than every `kit.ts` time (09:xx). */
export const at = (minute: number): string => new Date(Date.UTC(2026, 0, 15, 10, minute)).toISOString();

/** A live line. Run `n` ended at minute `n`. `over` replaces any field. */
export function live(n: number, cls: LiveLine["class"] = "clean", over: Partial<LiveLine> = {}): LiveLine {
  const failing = cls === "recipe_failure";
  return {
    run_id: runId(n),
    at: at(n),
    as: "task",
    mode: "unattended",
    class: cls,
    code: failing ? "target_not_found" : null,
    step: failing ? "click_search" : null,
    under: { engine: "0.4.0", handler_set: h("handlers"), jev: null },
    margins: {},
    differing: {},
    step_ms: {},
    ...over,
  };
}

/** `count` live lines from run `from`, all of class `cls`. */
export const lives = (from: number, count: number, cls: LiveLine["class"] = "clean"): LiveLine[] =>
  Array.from({ length: count }, (_, i) => live(from + i, cls));

const CAPABILITY = { name: "kvfcu/open_share_subaccount", version: "1.0.0", patch_revision: null };

/** Fields every result holds. */
function envelope(run: string) {
  return {
    schema: "intyy.result/1.0" as const,
    run_id: run,
    request_id: null,
    capability: CAPABILITY,
    warnings: [],
    recoveries: [],
    interventions: [],
    timing: { started_at: at(0), ended_at: at(1), duration_ms: 60000, human_ms: 0 },
    evidence: "evidence/keystone/runs/x",
  };
}

/** What a result may add to the status block. */
export type ResultOver = {
  effect?: { commit: string; check?: { run_id: string; decided_by: string; staff_id: string | null } };
  recoveries?: unknown[];
  interventions?: unknown[];
};

/** A `success` result. */
export function success(over: ResultOver = {}, run = runId(1)): Result {
  return Result.parse({ ...envelope(run), status: "success", outputs: {}, ...withEffect(over) });
}

/** A `business_outcome` result decided by `by`. */
export function outcome(by: "code" | "jev" | "human", over: ResultOver = {}, run = runId(1)): Result {
  return Result.parse({
    ...envelope(run),
    status: "business_outcome",
    outcome: { code: "member_not_found", description: "No such member.", step: "click_search", decided_by: by, set_by: by === "human" ? "op_022" : null },
    ...withEffect(over),
  });
}

/** A `failed` result with `code` at `step`. */
export function failed(code: string, step: string | null = "click_search", over: ResultOver = {}, run = runId(1)): Result {
  return Result.parse({
    ...envelope(run),
    status: "failed",
    failure: {
      code,
      message: "The run failed.",
      step,
      phase: "target",
      expected: { condition: "c", description: "d" },
      observed: { location: "/home", checks: [] },
      attempts: 1,
      ladder: { rung: 0, verdict: "none", ref: "none" },
      transient: false,
      safe_to_retry: false,
      files: [],
    },
    ...withEffect(over),
  });
}

/** A `rejected` result. */
export function rejected(run = runId(1)): Result {
  return Result.parse({
    ...envelope(run),
    status: "rejected",
    rejection: { errors: [{ code: "context_not_approved", message: "Not approved." }] },
  });
}

/** An `escalated` result. */
export function escalated(run = runId(1)): Result {
  return Result.parse({
    ...envelope(run),
    status: "escalated",
    escalation: {
      kind: "takeover",
      reason: "stuck",
      step: "click_search",
      waiting_since: at(0),
      deadline: at(30),
      handled_by: null,
      poll_after_ms: 1000,
    },
  });
}

/** Applies the `over` fields that may differ from the envelope. */
function withEffect(over: ResultOver): Record<string, unknown> {
  return {
    ...(over.effect === undefined ? {} : { effect: { performed_by: "bot", sent_at: at(0), attempts: [], ...over.effect } }),
    ...(over.recoveries === undefined ? {} : { recoveries: over.recoveries }),
    ...(over.interventions === undefined ? {} : { interventions: over.interventions }),
  };
}

/** One resolved human decision. */
export function intervention(kind: string, reason: string, step: string | null = "click_search", decision = "approved"): unknown {
  return {
    kind,
    reason,
    step,
    staff_id: "op_022",
    decision,
    requested_at: at(0),
    resolved_at: at(1),
    human_actions: 0,
    resumed_at_step: step,
  };
}

let seq = 0;
/** One run-log line, shaped like the executor writes it. */
export function ev(event: string, step: string | null, data: Record<string, unknown> = {}, by = "engine"): unknown {
  return { seq: seq++, event, step, by, data };
}

/** A `run_end` line that names the last step. */
export const runEnd = (step: string | null, status = "failed", code: string | null = null): unknown =>
  ev("run_end", step, { status, code });

/** A `target_vote` line. */
export const vote = (step: string, target: string, margin: number, disagree: string[] = []): unknown =>
  ev("target_vote", step, { target, margin, disagree, agree: [], missing: [], candidates: 1, score: 1, winner: "w" });

/** A passed `step_end` line with its clean time. */
export const stepEnd = (step: string, ms: number): unknown => ev("step_end", step, { result: "passed", observed_ms: ms });

/** A `ladder` line at `rung`. */
export const ladder = (step: string, rung: number, by = "engine"): unknown => ev("ladder", step, { rung }, by);

/** One world of fakes: a score store, in-memory locks, a clock, and a sealed-artifact lookup. */
export function world() {
  const slots = new MemoryLockSlots();
  const clock = new SteppingClock("2026-01-15T11:00:00.000Z");
  const scores = new FakeScoreStore<HistoryLine, ScoreRecord>({ line: HistoryLineSchema, record: ScoreRecordSchema });
  const locks = new LockManager(slots, clock, { host: "host-a", pid: 1001, isAlive: () => true });
  /** A second process on the same slots, for holding the lock from outside. */
  const other = new LockManager(slots, clock, { host: "host-a", pid: 1002, isAlive: () => true });
  const artifacts: SealedArtifacts = {
    getSealedArtifact: () =>
      Promise.resolve({ ok: true as const, value: { identity: { app: "kvfcu", capability: "open_share_subaccount", version: "1.0.0" } } }),
  };
  return { scores, locks, other, clock, artifacts, deps: { scores, locks, artifacts } };
}

/** Who a score write names. */
export const WHO = { owner: runId(99), command: "replay", staff: null };
