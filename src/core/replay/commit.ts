// The commit path: the one irreversible step of a replay run. Live re-check, then a durable
// `commit_intent` (via the gate's `beforeDispatch` hook), then the act, then the outcome race,
// then the effect block. Follows design section 4 §7.8 (the four checks, esp. check 4's live
// re-check), section 3 §6.6 (write-ahead) and §5.8 (the effect block), section 1 §19 ("Commit
// points"), section 2 §16.6 (commit states). Recovery states (`found_by_check`,
// `absent_by_check`) are reconciliation, M06: not built here.
import type { Clock } from "../../ports/clock.js";
import type { Eyes, LeaseToken, Observation } from "../../ports/surface.js";
import type { Condition } from "../model/artifact/conditions.js";
import type { ContractOutcome, ContractOutput } from "../model/artifact/contract.js";
import type { Step, StepAction } from "../model/artifact/steps.js";
import type { Target } from "../model/artifact/targets.js";
import type { EffectBlock } from "../model/result.js";
import type { Gate, GateFailure } from "../safety/gate/gate.js";
import type { Redactor } from "../safety/redaction/redactor.js";
import { actStep, type ActContext, type ActStepResult } from "./act.js";
import type { AnyCheck } from "../targets/evaluate.js";
import { picOf, type RecordedPictures } from "../targets/picture.js";
import { raceCheckpointAndOutcomes, type RaceOutcome, type RaceResult } from "./wait.js";

/** Asks a human for a commit approval when no authorization is present (docs/decisions.md, M05:
 * "The answer is `approved`/`declined`"). `intent` is the step's own `intent` text, for the
 * mailbox request. */
export interface CommitApproval {
  ask(
    ask: { step: string; intent: string; screenshot: string | null },
    signal?: AbortSignal,
  ): Promise<
    | { kind: "approved"; staff: string }
    | { kind: "declined" }
    | { kind: "timed_out" }
    | { kind: "run_ended" }
  >;
}

/** What `commitStep` needs, besides the step and its contract outcomes. */
export type CommitContext = {
  observation: Observation;
  eyes: Eyes;
  targets: ReadonlyMap<string, Target>;
  conditions: ReadonlyMap<string, Condition>;
  outputs: ReadonlyMap<string, ContractOutput>;
  refs: ReadonlyMap<string, string> | undefined;
  redactor: Redactor;
  gate: Gate;
  lease: LeaseToken;
  clock: Clock;
  /** Present only in supervised mode; unattended runs with no valid authorization also pause
   * here (docs/decisions.md, M05: "missing authorization never blocks the start"). */
  approval: CommitApproval;
  /** The artifact's decoded sealed crops, for the `image` clue (section 7 §6.3). Absent: none. */
  recorded?: RecordedPictures;
  /** A masked screenshot path for the approval request, if one was taken. */
  screenshot: string | null;
  /** Passed to `actStep`: logs the commit target's vote (section 3 §6.4). */
  onVote?: ActContext["onVote"];
  signal?: AbortSignal;
};

/** How the commit step ended. `evidence_write_failed` and `gate_failure` are hard failures
 * (section 3 §6.6; M05: "any unexpected screen is a hard failure"), not a commit state. */
export type CommitResult =
  | { kind: "effect"; effect: EffectBlock; race?: RaceResult }
  | { kind: "evidence_write_failed" }
  | { kind: "gate_failure"; failure: GateFailure };

/** An `effect` block with no send: `not_sent` (section 3 §5.8, "`null` when `not_sent`"). */
function notSent(): EffectBlock {
  return { commit: "not_sent", performed_by: null, sent_at: null, attempts: [] };
}

/** An `effect` block after a real send. `performed_by` stays `bot`: M05 builds no takeovers, so
 * only the bot ever sends the commit action (section 3 §5.8, "M07"). */
function sent(commit: "confirmed" | "refused" | "uncertain", sentAt: string): EffectBlock {
  return { commit, performed_by: "bot", sent_at: sentAt, attempts: [] };
}

/** The action's own target name, or null for `navigate`/`press` (section 2 §15.2). */
function targetIdOf(action: StepAction): string | null {
  return action.type === "navigate" || action.type === "press" ? null : action.target;
}

/** The words a human confirmed at review: the target's own recorded `name` and `text` clues
 * (section 4 §7.8 check 4). There is no separate "confirmed" field: sealing the artifact is the
 * confirmation (docs/decisions.md). */
function confirmedWords(target: Target): readonly string[] {
  return [target.clues.name, target.clues.text].filter((w): w is string => w !== undefined);
}

/** One check as a `ref` to a named condition (section 2 §14.2). */
const ref = (id: string): AnyCheck => ({ check: "ref", ref: id });

/** Proposes the commit step's action, with the live re-check's recorded words attached. */
function proposeCommit(
  step: Step,
  target: Target | null,
  ctx: CommitContext,
  approval: { by: string } | undefined,
): Promise<ActStepResult> {
  const actCtx: ActContext = {
    observation: ctx.observation,
    targets: ctx.targets,
    outputs: ctx.outputs,
    refs: ctx.refs,
    redactor: ctx.redactor,
    gate: ctx.gate,
    lease: ctx.lease,
    stepId: step.id,
    commitPoint: true,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    ...(target === null
      ? {}
      : { confirmed: { risk: step.risk, words: confirmedWords(target), ...picOf(ctx.recorded, target) } }),
    ...(ctx.recorded === undefined ? {} : { pictures: { eyes: ctx.eyes, recorded: ctx.recorded } }),
    ...(ctx.onVote === undefined ? {} : { onVote: ctx.onVote }),
    ...(approval === undefined ? {} : { approval }),
  };
  return actStep(step.action, actCtx);
}

/**
 * Runs the run's one commit step (section 1 §19, section 4 §7.8). The step's action must carry
 * a `target` (a bare `navigate`/`press` step is never the commit point in practice, since check
 * 4's live re-check needs a control to read).
 */
export async function commitStep(
  step: Step,
  contractOutcomes: readonly ContractOutcome[],
  ctx: CommitContext,
): Promise<CommitResult> {
  const targetId = targetIdOf(step.action);
  const target = targetId === null ? null : (ctx.targets.get(targetId) ?? null);

  let acted = await proposeCommit(step, target, ctx, undefined);
  if (acted.outcome.kind === "target_not_found" || acted.outcome.kind === "target_ambiguous") {
    return { kind: "effect", effect: notSent() };
  }
  if (acted.outcome.kind !== "acted") {
    throw new Error(`commitStep: ${step.id}'s action does not reach the gate (${acted.outcome.kind})`);
  }
  let gated = acted.outcome.gate;
  if (!gated.ok) return gateFailureOf(gated.failure);

  // No valid authorization: the gate asks for one (section 4 §7.8 check 1); supervised mode
  // pauses here at the mailbox (docs/decisions.md, M05).
  if (gated.value.decision === "needs_approval") {
    const answer = await ctx.approval.ask(
      { step: step.id, intent: step.intent, screenshot: ctx.screenshot },
      ctx.signal,
    );
    if (answer.kind !== "approved") return { kind: "effect", effect: notSent() };
    acted = await proposeCommit(step, target, ctx, { by: answer.staff });
    if (acted.outcome.kind !== "acted") {
      throw new Error(`commitStep: ${step.id}'s retry does not reach the gate`);
    }
    gated = acted.outcome.gate;
    if (!gated.ok) return gateFailureOf(gated.failure);
  }

  if (gated.value.decision !== "allowed") return { kind: "effect", effect: notSent() };
  const act = gated.value.act;
  if (act === undefined || act.dispatched === false) return { kind: "effect", effect: notSent() };

  // Sent. Race the checkpoint against the declared outcomes (section 7 §5.3).
  const sentAt = ctx.clock.now().toISOString();
  const outcomes: RaceOutcome[] = contractOutcomes
    .filter((o) => step.outcomes.includes(o.code))
    .map((o) => ({ code: o.code, condition: ref(o.condition) }));
  const race = await raceCheckpointAndOutcomes(
    ref(step.checkpoint),
    outcomes,
    ctx.eyes,
    {
      targets: ctx.targets,
      conditions: ctx.conditions,
      ...(ctx.refs === undefined ? {} : { refs: ctx.refs }),
    },
    step.timeout_ms,
    ctx.clock,
    ctx.signal,
  );
  // Why uncertain either way: a lost screen mid-race is exactly "sent, then something failed"
  // (section 2 §16.6); so is a race that times out with no winner. Assume the worst.
  if (!race.ok) return { kind: "effect", effect: sent("uncertain", sentAt) };
  const commit = race.value.winner === "checkpoint" ? "confirmed" : race.value.winner === "outcome" ? "refused" : "uncertain";
  return { kind: "effect", effect: sent(commit, sentAt), race: race.value };
}

function gateFailureOf(failure: GateFailure): CommitResult {
  return failure === "evidence_write_failed"
    ? { kind: "evidence_write_failed" }
    : { kind: "gate_failure", failure };
}
