// One step's engine loop (precondition, act, settle, the outcome race), and the prelude that
// replays a session artifact before the task (section 7 §4, §10). `runStep` is deliberately
// artifact-agnostic, so a later milestone's discovery prelude can reuse it (section 6 §5.5).
// In this milestone, any unexpected screen is a hard failure: no ladder, no retries (M06).
import type { Clock } from "../../ports/clock.js";
import type { Masked } from "../../ports/masked.js";
import type { Eyes, LeaseToken } from "../../ports/surface.js";
import { actStep, type ActContext } from "./act.js";
import type { Artifact } from "../model/artifact.js";
import type { ContractOutcome, ContractOutput } from "../model/artifact/contract.js";
import type { Step, StepAction } from "../model/artifact/steps.js";
import type { Target } from "../model/artifact/targets.js";
import type { Condition } from "../model/artifact/conditions.js";
import type { FailureCode } from "../model/result.js";
import type { Gate } from "../safety/gate/gate.js";
import type { Redactor } from "../safety/redaction/redactor.js";
import { settleAfterAction } from "./settle.js";
import { raceCheckpointAndOutcomes, waitForCondition, type RaceOutcome } from "./wait.js";
import type { AnyCheck, EvalCtx } from "../targets/evaluate.js";

/** How long a precondition may wait: the previous step already waited for its own screen
 * (section 7 §5.2). */
export const PRECONDITION_TIMEOUT_MS = 5_000;

/** What one step needs to run: the live session, the artifact's shared blocks, and where to
 * log it (`session:<id>` in the prelude, the bare step ID in the task). */
export type StepRunnerContext = {
  eyes: Eyes;
  gate: Gate;
  targets: ReadonlyMap<string, Target>;
  conditions: ReadonlyMap<string, Condition>;
  outputs: ReadonlyMap<string, ContractOutput>;
  contractOutcomes: readonly ContractOutcome[];
  refs: ReadonlyMap<string, string> | undefined;
  redactor: Redactor;
  lease: LeaseToken;
  clock: Clock;
  /** `"session:"` in the prelude, `""` in the task (section 7 §10, "Log them as `session:<step_id>`"). */
  logPrefix: string;
  signal?: AbortSignal;
};

/** Why a step failed hard: a code and phase for the result's `failure` block, and the log line. */
export type StepFailure = { code: FailureCode; phase: string; message: string };

/** One step's outcome (section 7 §4 point 7): it passed, a declared outcome fired, or it failed
 * hard. A `read` step's value rides along on `ok`. */
export type StepOutcome =
  | { kind: "ok"; read?: { output: string; raw: string; masked: Masked<string> } }
  | { kind: "outcome"; code: string }
  | { kind: "failed"; failure: StepFailure };

/** One check as a `ref` to a named condition (section 2 §14.2). */
const ref = (id: string): AnyCheck => ({ check: "ref", ref: id });

/** The action's own target name, or null for `navigate`/`press` (section 2 §15.2). */
function targetIdOf(action: StepAction): string | null {
  return "target" in action ? action.target : null;
}

/** The words a human confirmed at review: the target's own recorded `name` and `text` clues
 * (section 4 §7.8 check 4). There is no separate "confirmed" field: sealing the artifact is the
 * confirmation (docs/decisions.md; mirrors `commit.ts`'s own `confirmedWords`). */
function confirmedWords(target: Target): readonly string[] {
  return [target.clues.name, target.clues.text].filter((w): w is string => w !== undefined);
}

function evalCtxOf(ctx: StepRunnerContext): EvalCtx {
  return {
    targets: ctx.targets,
    conditions: ctx.conditions,
    ...(ctx.refs === undefined ? {} : { refs: ctx.refs }),
  };
}

/** Races the step's checkpoint against its declared outcomes (section 7 §5.3). */
async function raceStep(step: Step, ctx: StepRunnerContext): Promise<StepOutcome> {
  const outcomes: RaceOutcome[] = ctx.contractOutcomes
    .filter((o) => step.outcomes.includes(o.code))
    .map((o) => ({ code: o.code, condition: ref(o.condition) }));
  const race = await raceCheckpointAndOutcomes(
    ref(step.checkpoint),
    outcomes,
    ctx.eyes,
    evalCtxOf(ctx),
    step.timeout_ms,
    ctx.clock,
    ctx.signal,
  );
  if (!race.ok) {
    return {
      kind: "failed",
      failure: { code: "session_lost", phase: "checkpoint", message: "the screen went away during the checkpoint wait" },
    };
  }
  if (race.value.winner === "checkpoint") return { kind: "ok" };
  if (race.value.winner === "outcome") return { kind: "outcome", code: race.value.code };
  return {
    kind: "failed",
    failure: { code: "checkpoint_timeout", phase: "checkpoint", message: `step ${step.id}'s checkpoint never passed` },
  };
}

/**
 * Runs one step: precondition, act, settle, the outcome race (section 7 §4 point 7, minus the
 * commit-only sub-steps, which the caller handles through `commitStep`). Never the commit step.
 */
export async function runStep(step: Step, ctx: StepRunnerContext): Promise<StepOutcome> {
  const stepId = `${ctx.logPrefix}${step.id}`;
  const pre = await waitForCondition(
    ref(step.precondition),
    ctx.eyes,
    evalCtxOf(ctx),
    PRECONDITION_TIMEOUT_MS,
    ctx.clock,
    ctx.signal,
  );
  if (!pre.ok) {
    return { kind: "failed", failure: { code: "session_lost", phase: "precondition", message: "the screen went away while waiting for the precondition" } };
  }
  if (pre.value.answer !== "true") {
    return { kind: "failed", failure: { code: "precondition_failed", phase: "precondition", message: `step ${step.id}'s precondition never became true` } };
  }

  const observed = await ctx.eyes.observe(ctx.signal);
  if (!observed.ok) {
    return { kind: "failed", failure: { code: "session_lost", phase: "target", message: "the screen went away before acting" } };
  }
  // Why no settle for `read`: nothing was dispatched, so nothing settles (section 9 §5.2).
  const events = step.action.type === "read" ? null : ctx.eyes.events(ctx.signal);
  const targetId = targetIdOf(step.action);
  const target = targetId === null ? null : (ctx.targets.get(targetId) ?? null);
  const actCtx: ActContext = {
    observation: observed.value,
    targets: ctx.targets,
    outputs: ctx.outputs,
    refs: ctx.refs,
    redactor: ctx.redactor,
    gate: ctx.gate,
    lease: ctx.lease,
    stepId,
    ...(target === null ? {} : { confirmed: { risk: step.risk, words: confirmedWords(target) } }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  };
  const acted = await actStep(step.action, actCtx);
  if (acted.outcome.kind === "target_not_found" || acted.outcome.kind === "target_ambiguous") {
    return { kind: "failed", failure: { code: acted.outcome.kind, phase: "target", message: `step ${step.id} could not find its target` } };
  }
  if (acted.outcome.kind === "read_failed") {
    return { kind: "failed", failure: { code: "output_parse_failed", phase: "extract", message: acted.outcome.detail } };
  }
  if (acted.outcome.kind === "read") {
    if (step.action.type !== "read") throw new Error("act: a read outcome from a non-read action");
    const raced = await raceStep(step, ctx);
    return raced.kind === "ok" ? { kind: "ok", read: { output: step.action.output, ...acted.outcome } } : raced;
  }

  // acted.outcome.kind === "acted": a gated action.
  if (!acted.outcome.gate.ok) {
    const failure = acted.outcome.gate.failure;
    return { kind: "failed", failure: { code: failure === "evidence_write_failed" ? "evidence_write_failed" : failure === "secret_unavailable" ? "secret_unavailable" : "session_lost", phase: "gate", message: `step ${step.id}: ${failure}` } };
  }
  if (acted.outcome.gate.value.decision !== "allowed") {
    return { kind: "failed", failure: { code: "action_blocked", phase: "gate", message: `step ${step.id} was blocked: ${acted.outcome.gate.value.rule}` } };
  }
  if (events !== null) await settleAfterAction(events, ctx.clock, step.timeout_ms, ctx.signal);
  ctx.gate.settled();
  return raceStep(step, ctx);
}

/** What one prelude run needs, on top of a step's own context (built once, reused per step). */
export type PreludeContext = Omit<StepRunnerContext, "logPrefix">;

/**
 * Replays the session artifact step by step (section 7 §10): navigate to its `entry`, then run
 * every step in order. No loop, no ladder: the first hard failure or declared outcome stops it.
 * Handlers with `sign_in` are M06; there is none to skip here yet.
 */
export async function runPrelude(
  session: Artifact,
  ctx: PreludeContext,
): Promise<{ kind: "ok" } | { kind: "outcome"; code: string } | { kind: "failed"; failure: StepFailure }> {
  const nav = await ctx.gate.act(
    { actor: "engine", lease: ctx.lease, action: { type: "navigate", to: session.runs_on.entry }, step: "session:entry" },
    ctx.signal,
  );
  if (!nav.ok || nav.value.decision !== "allowed" || nav.value.act?.dispatched === false) {
    return { kind: "failed", failure: { code: "app_unreachable", phase: "start", message: "could not navigate to the session's entry" } };
  }
  for (const step of session.steps) {
    const outcome = await runStep(step, { ...ctx, logPrefix: "session:" });
    if (outcome.kind !== "ok") return outcome;
  }
  return { kind: "ok" };
}
