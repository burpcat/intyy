// One step's engine loop (precondition, act, settle, the outcome race), and the prelude that
// replays a session artifact before the task (section 7 §4, §10). `runStep` is deliberately
// artifact-agnostic, so a later milestone's discovery prelude can reuse it (section 6 §5.5).
// In this milestone, any unexpected screen is a hard failure: no ladder, no retries (M06).
import type { Clock } from "../../ports/clock.js";
import type { Masked } from "../../ports/masked.js";
import type { Eyes, LeaseToken, SurfaceEvent } from "../../ports/surface.js";
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
import { measureWith, picOf, type RecordedPictures } from "../targets/picture.js";

/** How long a precondition may wait: the previous step already waited for its own screen
 * (section 7 §5.2). Why 10 s, not 5 s: a frameset app's frames fill in after the page that holds
 * them, so the previous step's checkpoint can pass on one frame while the next step's frame is
 * still loading (owner decision, 2026-10-02, after kvfcu's live fault cases). */
export const PRECONDITION_TIMEOUT_MS = 10_000;

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
  /** The artifact's decoded sealed crops, for the `image` clue (section 7 §6.3). Absent: none. */
  recorded?: RecordedPictures;
  /** Passed to `actStep`: logs each target vote (section 3 §6.4). */
  onVote?: ActContext["onVote"];
  signal?: AbortSignal;
};

/** A transport failure the surface reports (section 7 §7.3): the server closed the connection,
 * the browser showed its own error page, or a page load outlived the step timeout. Picks
 * `retry.transport` over `retry.idempotent` at the ladder's retry step (docs/decisions.md, M06). */
export type TransportSignal = "connection_closed" | "browser_error_page" | "navigation_timeout";

/** Watches one step's own event stream for a transport signal, without taking it from anyone
 * else: {@link watchTransport} passes every event through unchanged, so `settleAfterAction`
 * still sees them all; this only records the last transport-shaped one it saw. */
class TransportWatch {
  seen: TransportSignal | null = null;
  #navStarted = false;
  #navDone = false;

  see(e: SurfaceEvent): void {
    if (e.kind === "connection_closed") this.seen ??= "connection_closed";
    else if (e.kind === "browser_error_page") this.seen ??= "browser_error_page";
    else if (e.kind === "navigation_started") {
      this.#navStarted = true;
      this.#navDone = false;
    } else if (e.kind === "navigation_done") this.#navDone = true;
  }

  /** Call once the action's own wait is over: a navigation that started but never finished in
   * that window is a timeout (section 7 §7.3), unless a sharper signal already explains it. */
  finish(): void {
    if (this.seen === null && this.#navStarted && !this.#navDone) this.seen = "navigation_timeout";
  }
}

/** Wraps `events` so {@link TransportWatch} sees every event too, with no change to what the
 * real consumer (`settleAfterAction`) reads or when. */
async function* watchTransport(events: AsyncIterable<SurfaceEvent>, watch: TransportWatch): AsyncIterable<SurfaceEvent> {
  for await (const e of events) {
    watch.see(e);
    yield e;
  }
}

/** Why a step failed hard: a code and phase for the result's `failure` block, and the log line.
 * `transportEvent` is set only after a real dispatch, for the checkpoint phase (section 7 §7.3);
 * `undefined` or `null` elsewhere. */
export type StepFailure = { code: FailureCode; phase: string; message: string; transportEvent?: TransportSignal | null };

/** One step's outcome (section 7 §4 point 7): it passed, a declared outcome fired, or it failed
 * hard. A `read` step's value rides along on `ok`. */
export type StepOutcome =
  | {
      kind: "ok";
      read?: { output: string; raw: string; masked: Masked<string> };
      /** Milliseconds from the action to the checkpoint passing: certify's timeout sample (section 8 §9.6). */
      observedMs?: number;
    }
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
    ...(ctx.recorded === undefined
      ? {}
      : { measure: measureWith({ eyes: ctx.eyes, recorded: ctx.recorded }, ctx.targets, ctx.redactor, ctx.signal) }),
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
  const transport = new TransportWatch();
  const events = step.action.type === "read" ? null : watchTransport(ctx.eyes.events(ctx.signal), transport);
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
    ...(target === null
      ? {}
      : {
          confirmed: {
            risk: step.risk,
            words: confirmedWords(target),
            ...picOf(ctx.recorded, target),
          },
        }),
    ...(ctx.recorded === undefined ? {} : { pictures: { eyes: ctx.eyes, recorded: ctx.recorded } }),
    ...(ctx.onVote === undefined ? {} : { onVote: ctx.onVote }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  };
  const acted = await actStep(step.action, actCtx);
  // Why here: section 8 §9.6, "a step's observed time runs from its action to its checkpoint passing".
  const actedAtMs = ctx.clock.now().getTime();
  if (acted.outcome.kind === "target_not_found" || acted.outcome.kind === "target_ambiguous") {
    return { kind: "failed", failure: { code: acted.outcome.kind, phase: "target", message: `step ${step.id} could not find its target` } };
  }
  if (acted.outcome.kind === "read_failed") {
    return { kind: "failed", failure: { code: "output_parse_failed", phase: "extract", message: acted.outcome.detail } };
  }
  if (acted.outcome.kind === "read") {
    if (step.action.type !== "read") throw new Error("act: a read outcome from a non-read action");
    const raced = await raceStep(step, ctx);
    return raced.kind === "ok"
      ? { kind: "ok", read: { output: step.action.output, ...acted.outcome }, observedMs: ctx.clock.now().getTime() - actedAtMs }
      : raced;
  }

  // acted.outcome.kind === "acted": a gated action.
  if (!acted.outcome.gate.ok) {
    const failure = acted.outcome.gate.failure;
    // Why: a frame that reloads between the vote and the gate's own look leaves the voted ref
    // gone. Nothing was sent, so it is a target miss the ladder's retry re-votes, not a lost session.
    if (failure === "stale_element") {
      return { kind: "failed", failure: { code: "target_not_found", phase: "target", message: `step ${step.id}: its target changed before acting` } };
    }
    return { kind: "failed", failure: { code: failure === "evidence_write_failed" ? "evidence_write_failed" : failure === "secret_unavailable" ? "secret_unavailable" : "session_lost", phase: "gate", message: `step ${step.id}: ${failure}` } };
  }
  if (acted.outcome.gate.value.decision !== "allowed") {
    return { kind: "failed", failure: { code: "action_blocked", phase: "gate", message: `step ${step.id} was blocked: ${acted.outcome.gate.value.rule}` } };
  }
  if (events !== null) await settleAfterAction(events, ctx.clock, step.timeout_ms, ctx.signal);
  ctx.gate.settled();
  transport.finish();
  const raced = await raceStep(step, ctx);
  if (raced.kind === "failed" && transport.seen !== null) {
    return { kind: "failed", failure: { ...raced.failure, transportEvent: transport.seen } };
  }
  return raced.kind === "ok" ? { ...raced, observedMs: ctx.clock.now().getTime() - actedAtMs } : raced;
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
