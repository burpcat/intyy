// The error ladder: rung 1 (declared outcomes, handlers, retry), then rung 2 (jev), rung 3 (the
// reviewer), else a climb to rung 4 (a takeover).
// Follows design section 5 §2 (principles), §4 (the ladder), §8.1 to §8.8, §8.10 to §8.13
// (rungs 1 to 3, the helper window, the pre-commit sweep, the resume rule, verdicts, log lines),
// §9.4 (undeclared outcomes), §10 (jev), §11 (the reviewer), §14 (the bank's faults); section 7
// §7.2 to §7.3 (transport failures), §8 (limits), §10 (`sign_in` recovery); docs/decisions.md,
// M06 (a location-only precondition never counts as a known screen; a `hard_failure` handler's
// `transient` flag from a fixed map) and M09 (rungs 2 and 3).
//
// Models appear only here, on rungs 2 and 3, and only with the helper window open and the rung's
// port present (`LadderDeps.rungs`). With no `rungs`, a climb means "rung 4", as in M06. This
// module only decides that plain code cannot answer; rung 4 is the caller's own choice.
import type { Clock } from "../../ports/clock.js";
import type { Eyes, LeaseToken, Observation } from "../../ports/surface.js";
import type { Condition } from "../model/artifact/conditions.js";
import type { ContractOutcome } from "../model/artifact/contract.js";
import type { RiskKind } from "../model/artifact/steps.js";
import type { Handler, HandlerAction, PackTarget } from "../model/pack.js";
import type { FrozenSet } from "../packs/merge.js";
import { breakTie } from "../packs/merge.js";
import type { Gate, GateAction } from "../safety/gate/gate.js";
import type { LogLine } from "../orchestrator/run-log.js";
import { fact, type Redactor } from "../safety/redaction/redactor.js";
import { evaluate, type AnyCheck, type EvalCtx } from "../targets/evaluate.js";
import { fromObservation, type ScreenView } from "../targets/screen.js";
import { resolveRefs } from "../targets/text.js";
import { maskedScreenshot } from "../safety/redaction/images.js";
import { CLICK_READY_MS } from "./act.js";
import { findTarget } from "./find-target.js";
import { troubleVerdict } from "./jev-verdict.js";
import type { ReviewerInput } from "../../ports/models.js";
import { jevTroubleInput, reviewerGateAction, reviewerInput, type RungDeps, type TroubleFacts } from "./rung-input.js";
import { waitForCondition } from "./wait.js";

/** Section 7 §8: retries per step, handler attempts per step and per run, ladder entries per
 * run, rewinds per run, and `sign_in` runs per run. The lower of a handler's own cap and the
 * engine cap wins (§8, "The lower ... wins"). */
export const RETRY_MAX_PER_STEP = 2;
export const HANDLER_ATTEMPTS_PER_STEP = 3;
export const HANDLER_ATTEMPTS_PER_RUN = 6;
export const LADDER_ENTRIES_PER_RUN = 8;
export const REWINDS_PER_RUN = 4;
export const SIGN_IN_RUNS_PER_RUN = 2;
/** Section 7 §8, section 5 §11.5: reviewer calls per stuck step, and per run. */
export const REVIEWER_CALLS_PER_STEP = 1;
export const REVIEWER_CALLS_PER_RUN = 2;

/** Section 5 §8.2: open when nothing risky is in flight, or the one in flight is `idempotent`.
 * `dispatched: false` means nothing was sent at all, whatever the step's own risk. */
export type Window = "open" | "closed";

/** Section 5 §8.10: what a rung answers, and how the run goes on. */
export type Verdict = "business_outcome" | "recovered" | "hard_failure" | "needs_human" | "climb";

/** One `ladder` log line's `data` (section 5 §8.12). `files` names the screenshot and a11y
 * snapshot the caller saved at this ladder's start (docs/decisions.md, M06: "Every ladder start
 * saves the masked accessibility snapshot beside the screenshot"). */
export type LadderLogData = {
  rung: 1 | 2 | 3;
  verdict: Verdict;
  window: Window;
  matched: readonly string[];
  handler: string | null;
  attempt: number;
  next: "continue" | "resume_at" | "rung_2" | "rung_3" | "takeover" | "reconcile" | "end";
  resume_at: string | null;
  files: readonly string[];
  /** jev lines only (section 5 §8.12): the bucket, its confidence, and the threshold it met or missed. */
  bucket?: string;
  confidence?: number;
  threshold?: number;
  /** jev or reviewer lines: the relative path of the request file in `llm/` (section 5 §8.12). */
  input?: string;
};

/** What a rung 2 or rung 3 line adds to a `ladder` line (section 5 §8.12). */
type RungMark = Pick<LadderLogData, "rung" | "bucket" | "confidence" | "threshold" | "input">;

/** What went wrong, the way a step or the commit path already reports it, plus what the ladder
 * needs that a `StepFailure` does not carry: whether the trouble's own action was actually
 * dispatched, and, for a transport failure, which surface event it was (section 7 §7.3). */
export type LadderTrouble = {
  code: string;
  message: string;
  phase: "precondition" | "target" | "action" | "checkpoint";
  /** The failed step's own action risk (section 5 §8.2). Preconditions and target trouble have
   * not acted yet; pass the step's own risk anyway, it is only read when `dispatched` is not `false`. */
  risk: RiskKind;
  /** Was the trouble's own action sent? `false` for precondition/target trouble, or a blocked
   * click. `true` after a real dispatch, like a checkpoint that never passed. */
  dispatched: boolean;
  /** Set only for a transport failure (section 7 §7.3): picks `retry.transport` over
   * `retry.idempotent`, and where `{system.last_good_path}` sends the retry. */
  transportEvent: "connection_closed" | "browser_error_page" | "navigation_timeout" | null;
  /** `target_ambiguous` never retries (section 5 §8.4 step 4, "trouble not `target_ambiguous`"). */
  ambiguous: boolean;
};

/** One step's shape the resume rule and rung 1 both need: enough to check its precondition and
 * checkpoint, and whether it is safe to repeat (section 5 §8.6). */
export type LadderStep = { id: string; precondition: string; checkpoint: string; risk: RiskKind };

/** The counters `runLadder` reads to decide whether a rung may still act (section 7 §8). The
 * caller owns updating them between calls; this module never mutates anything itself. */
export type LadderLimits = {
  retriesUsedThisStep: number;
  handlerAttemptsThisStep: Readonly<Record<string, number>>;
  handlerAttemptsThisRun: number;
  signInRunsUsed: number;
  ladderEntriesUsed: number;
  rewindsUsed: number;
};

/** Section 3 §5.10: one automatic recovery, in the shape the result's `recoveries[]` wants. */
export type LadderRecovery = { via: "handler" | "retry" | "jev" | "reviewer"; ref: string; resumedAt: string };

/** What `runLadder` answers (section 5 §8.10). `index` for `recovered` is the step to resume at,
 * or the failed step's own index for a plain "continue." */
export type LadderResult =
  /** `decidedBy: "jev"` when rung 2 named the outcome (section 3 §5.8); absent means plain code. */
  | { kind: "business_outcome"; code: string; decidedBy?: "jev"; log: LadderLogData }
  | { kind: "recovered"; index: number; recovery: LadderRecovery; log: LadderLogData }
  | { kind: "hard_failure"; code: string; message: string; transient: boolean; ladderRef: string; log: LadderLogData }
  | { kind: "needs_human"; operatorNote: string; log: LadderLogData }
  /** A takeover with reason `unsafe_state`: jev said `unsafe`, or the gate blocked the reviewer (section 5 §8.7, §11.3). */
  | { kind: "unsafe"; log: LadderLogData }
  | { kind: "climb"; log: LadderLogData };

/** Section 5 §8.2: the helper window. `dispatched` mirrors `ActResult.dispatched`; `"unknown"`
 * counts the same as `true` (section 7 §7.2, "in flight" either way). */
export function helperWindow(risk: RiskKind, dispatched: boolean | "unknown"): Window {
  if (dispatched === false) return "open";
  return risk === "idempotent" ? "open" : "closed";
}

/** One check as a `ref` to a named condition (section 2 §14.2). */
function ref(id: string): AnyCheck {
  return { check: "ref", ref: id };
}

/** True when `check` answers `true` on `screen` (section 5 §8.3, §8.6: "checked once, with no
 * wait"). Shared by the pre-commit sweep, the declared-outcome check, and the resume rule. */
function passes(id: string, screen: ScreenView, ctx: EvalCtx): boolean {
  return evaluate(ref(id), screen, ctx) === "true";
}

/**
 * Every frozen handler whose detector matches `screen`, checked once, no wait (section 5 §7.6,
 * §8.3, §8.4 step 3). Shared by rung 1's own handler step and the pre-commit sweep (section 5
 * §8.3): the sweep is the same check, run at a different moment and logged with role `sweep`.
 */
export function matchDetectors(
  handlers: readonly Handler[],
  screen: ScreenView,
  ctx: EvalCtx,
): string[] {
  return handlers.filter((h) => passes(h.detector, screen, ctx)).map((h) => h.id);
}

/** Walks one condition's tree for the location-only check (section 5 §14, docs/decisions.md
 * M06): every leaf must be `location`; `all_of`/`any_of`/`not` combine; a `ref` follows the
 * named condition. A condition this walks is already loop-free (the loader checked that). */
function isLocationOnlyNode(node: AnyCheck, conditions: ReadonlyMap<string, Condition>): boolean {
  if ("checks" in node) return node.checks.every((c) => isLocationOnlyNode(c, conditions));
  if ("of" in node) return isLocationOnlyNode(node.of, conditions);
  if (node.check === "location") return true;
  if (node.check === "ref" || node.check === undefined) {
    const next = conditions.get(node.ref);
    return next !== undefined && isLocationOnlyNode(next, conditions);
  }
  return false;
}

/**
 * True when `conditionId`'s whole tree checks only `location` (docs/decisions.md, M06): every
 * kvfcu task page sits under the same frameset, so a bare location check can pass under an
 * unknown pop-up. Such a precondition never counts as "a known screen" at rung 1 step 5.
 */
export function isLocationOnly(conditionId: string, conditions: ReadonlyMap<string, Condition>): boolean {
  const c = conditions.get(conditionId);
  return c !== undefined && isLocationOnlyNode(c, conditions);
}

/** The resume rule (section 5 §8.6): one screen, checked once. `failedIndex` is the step that
 * had trouble; `floorIndex` is the rewind floor (never searched below). */
export function resumeSearch(
  steps: readonly LadderStep[],
  failedIndex: number,
  failedStepDispatched: boolean,
  floorIndex: number,
  screen: ScreenView,
  ctx: EvalCtx,
): { kind: "continue" } | { kind: "resume_at"; index: number } | { kind: "not_recovered" } {
  const failed = steps[failedIndex];
  if (failed === undefined) throw new Error("resumeSearch: failedIndex is out of range");

  // 1. Did the failed step act, and does its checkpoint pass now?
  if (failedStepDispatched && passes(failed.checkpoint, screen, ctx)) return { kind: "continue" };

  // 2. Search back for the latest step whose precondition passes now.
  let latest: number | null = null;
  for (let i = failedIndex; i >= floorIndex; i--) {
    const step = steps[i];
    if (step !== undefined && passes(step.precondition, screen, ctx)) {
      latest = i;
      break;
    }
  }
  if (latest === null) return { kind: "not_recovered" };

  // 3. Extend back while the step before also passes its precondition now.
  let resumeIndex = latest;
  for (let i = latest - 1; i >= floorIndex; i--) {
    const step = steps[i];
    if (step === undefined || !passes(step.precondition, screen, ctx)) break;
    resumeIndex = i;
  }

  // The chain to re-run, `resumeIndex` up to (not including) the failed step, must be safe to
  // repeat: every one of those steps is `idempotent` (section 5 §8.6, "Limits on the search").
  // The failed step itself is exempt: rung 1 only reaches here with the window open (helperWindow),
  // so it is either idempotent already or never dispatched.
  for (let i = resumeIndex; i < failedIndex; i++) {
    if (steps[i]?.risk !== "idempotent") return { kind: "not_recovered" };
  }
  return { kind: "resume_at", index: resumeIndex };
}

/** The words a human confirmed at review for a pack target: its own recorded `name` and `text`
 * clues (section 4 §7.8 check 4; mirrors `act.ts`'s own `confirmedWords`). */
function confirmedWordsOf(target: PackTarget): readonly string[] {
  return [target.clues.name, target.clues.text].filter((w): w is string => w !== undefined);
}

/** What running one handler's response actions needs, besides the action list itself. */
export type ResponseDeps = {
  eyes: Eyes;
  gate: Gate;
  clock: Clock;
  redactor: Redactor;
  lease: LeaseToken;
  refs: ReadonlyMap<string, string> | undefined;
  packTargets: ReadonlyMap<string, PackTarget>;
  /** `{system.last_good_path}` (docs/decisions.md, M06): the top-level page's path and query,
   * from the last step whose checkpoint passed. The caller tracks it; the ladder only reads it. */
  lastGoodPath: string;
  /** Re-runs the session artifact's steps in the same browser (section 7 §10). Only a `sign_in`
   * response action calls this; a handler set with no session link never reaches here (the
   * frozen set already drops it, section 5 §7.4 step 7). */
  runPrelude: (signal?: AbortSignal) => Promise<boolean>;
  step: string;
  signal?: AbortSignal;
};

/** Runs one response action (section 5 §6.4). `false` stops the response: the handler did not
 * recover, and the caller falls through to "not recovered" (climb). */
async function runResponseAction(action: HandlerAction, deps: ResponseDeps): Promise<boolean> {
  if (action.type === "sign_in") {
    const proposed = await deps.gate.act(
      { actor: "handler", lease: deps.lease, action: { type: "sign_in", risk: action.risk }, step: deps.step },
      deps.signal,
    );
    if (!proposed.ok || proposed.value.decision !== "allowed") return false;
    return deps.runPrelude(deps.signal);
  }
  if (action.type === "navigate") {
    const to = action.location === "{system.last_good_path}" ? deps.lastGoodPath : action.location;
    const proposed = await deps.gate.act(
      { actor: "handler", lease: deps.lease, action: { type: "navigate", to }, step: deps.step },
      deps.signal,
    );
    return proposed.ok && proposed.value.decision === "allowed" && proposed.value.act?.dispatched !== false;
  }
  if (action.type === "press") {
    const proposed = await deps.gate.act(
      { actor: "handler", lease: deps.lease, action: { type: "press", key: action.key, target: null }, step: deps.step },
      deps.signal,
    );
    return proposed.ok && proposed.value.decision === "allowed";
  }
  const observed = await deps.eyes.observe(deps.signal);
  if (!observed.ok) return false;
  const target = deps.packTargets.get(action.target);
  if (target === undefined) throw new Error(`handler response names unknown target ${action.target}`);
  // Why no pictures: handler pack targets keep no sealed crops, so `image` stays missing.
  const found = findTarget(target, observed.value, deps.packTargets, deps.refs, deps.redactor);
  if (found.kind !== "winner") return false;
  const gateAction: GateAction =
    action.type === "click"
      ? { type: "click", target: found.ref, readinessTimeoutMs: CLICK_READY_MS }
      : action.type === "type"
        ? { type: "type", target: found.ref, value: { kind: "text", text: resolveRefs(action.value, deps.refs) } }
        : action.type === "select"
          ? { type: "select", target: found.ref, option: resolveRefs(action.value, deps.refs) }
          : { type: "set_checked", target: found.ref, checked: action.checked };
  const proposed = await deps.gate.act(
    {
      actor: "handler",
      lease: deps.lease,
      action: gateAction,
      step: deps.step,
      confirmed: { risk: action.risk, words: confirmedWordsOf(target) },
    },
    deps.signal,
  );
  return proposed.ok && proposed.value.decision === "allowed" && proposed.value.act?.dispatched !== false;
}

/** Runs every response action in order (section 5 §6.4). Stops, and answers `false`, at the
 * first one that does not go through. */
async function runResponse(actions: readonly HandlerAction[], deps: ResponseDeps): Promise<boolean> {
  for (const action of actions) {
    if (!(await runResponseAction(action, deps))) return false;
  }
  return true;
}

/** `HardFailureCode`'s `transient` flag, from the fixed map (docs/decisions.md, M06): `app_error`
 * is transient (the app may recover on its own), `permission_denied` never is. */
const HARD_FAILURE_TRANSIENT: Record<"app_error" | "permission_denied", boolean> = {
  app_error: true,
  permission_denied: false,
};

/** What `runLadder` needs, besides the trouble and the frozen set. */
export type LadderDeps = {
  eyes: Eyes;
  gate: Gate;
  clock: Clock;
  redactor: Redactor;
  lease: LeaseToken;
  log: (line: LogLine) => void;
  /** The task's own targets and conditions, for the step-level checks: declared outcomes,
   * preconditions, and checkpoints (section 5 §8.4 step 2, §8.6). */
  taskCtx: EvalCtx;
  /** The frozen handler set's own targets and conditions, for detector matching and response
   * targets (section 5 §7.4, §7.6). */
  packCtx: EvalCtx;
  frozen: Pick<FrozenSet, "handlers" | "handlerScope" | "targets" | "conditions">;
  packTargets: ReadonlyMap<string, PackTarget>;
  lastGoodPath: string;
  runPrelude: (signal?: AbortSignal) => Promise<boolean>;
  /** Rungs 2 and 3. Absent: neither exists, and a climb goes to rung 4 (docs/decisions.md, M06). */
  rungs?: RungDeps;
  signal?: AbortSignal;
};

/** One `runLadder` call's own facts: the trouble, the steps to search over, and the limits
 * already used. */
export type LadderInput = {
  stepId: string;
  stepIndex: number;
  steps: readonly LadderStep[];
  floorIndex: number;
  trouble: LadderTrouble;
  /** The step's own declared outcomes: codes from `contract.outcomes` this step may show
   * (section 5 §8.4 step 2). Empty when the step declares none. */
  stepOutcomes: readonly ContractOutcome[];
  limits: LadderLimits;
  /** The screenshot and a11y snapshot the caller saved at this ladder's start
   * (docs/decisions.md, M06). Named on the `ladder` line, whatever the verdict. */
  captureFiles: readonly string[];
};

/**
 * Where a landing resumes (section 5 §8.6 rule 1). The failed step's checkpoint passed: go on with
 * the NEXT step, so a step that already acted is never run twice. Otherwise run the earlier step
 * the search found. The one place every rung turns a landing into a step index.
 */
function landingIndex(resumed: { kind: "continue" } | { kind: "resume_at"; index: number }, stepIndex: number): number {
  return resumed.kind === "continue" ? stepIndex + 1 : resumed.index;
}

/**
 * What a passing checkpoint means for a step the ladder just fixed (section 5 §8.6 rule 1, §11.3).
 * `next`: skip it, it acted or is safe to skip. `human`: an irreversible step the bot never sent,
 * yet its checkpoint shows; the bot cannot claim that work, so a person decides.
 * Why: CLAUDE.md "never retry an irreversible step"; running it would send it twice, and skipping
 * it would claim a change the bot never made. `no`: the checkpoint did not pass.
 */
function checkpointLanding(step: LadderStep, dispatched: boolean, checkpointPassed: boolean): "next" | "human" | "no" {
  if (!checkpointPassed) return "no";
  if (dispatched) return "next";
  return step.risk === "irreversible" ? "human" : step.risk === "idempotent" ? "next" : "no";
}

/** Appends one `ladder` line (section 5 §8.12: "Every rung writes one line"). */
function logLadder(deps: LadderDeps, step: string, data: LadderLogData, why: { kind: string; ref: string }): void {
  // Why `by`: section 3 §6.4, "jev verdicts are `ladder` lines with `by: jev`"; the reviewer's own line says `reviewer`.
  const by = data.rung === 2 ? "jev" : data.rung === 3 ? "reviewer" : "engine";
  // Why `fact`: the digit rule would mask `a11y/00029_…` in the log, and the takeover drafts read
  // these paths back as files. The paths are intyy's own (section 3 §7.2).
  deps.log({ event: "ladder", step, by, why, data: { ...data, files: data.files.map(fact) } });
}

/** A `warning` line (section 3 §6.4): something to review, not fatal. */
function logWarning(deps: LadderDeps, step: string, code: string, detail: string, handler?: string): void {
  // Why `handler`: section 8 §12.4 counts `detector_missed` per handler, so the drift reader reads the ID here.
  deps.log({ event: "warning", step, by: "engine", data: { code, detail, ...(handler === undefined ? {} : { handler }) } });
}

function logCheck(
  deps: LadderDeps,
  step: string,
  role: "handler" | "sweep",
  condition: string,
  passed: boolean,
): void {
  deps.log({ event: "check", step, by: "engine", data: { condition, role, passed } });
}

function logHandlerAction(deps: LadderDeps, step: string, handlerId: string, type: string, ok: boolean): void {
  deps.log({ event: "action", step, by: "handler", why: { kind: "handler", ref: handlerId }, data: { type, ok } });
}

/** True when the reviewer may still be called: its port is present, and it has calls left for
 * this stuck step and this run (section 5 §11.5, section 7 §8). */
function reviewerAvailable(r: RungDeps): boolean {
  return (
    r.reviewer !== null &&
    r.reviewerCalls.step < REVIEWER_CALLS_PER_STEP &&
    r.reviewerCalls.run < REVIEWER_CALLS_PER_RUN
  );
}

/** Where rung 1's climb goes next (section 5 §8.10): rung 2, rung 3, or rung 4 (a takeover). */
function nextAfterRung1(rungs: RungDeps | undefined): LadderLogData["next"] {
  if (rungs === undefined) return "takeover";
  if (rungs.jev !== null) return "rung_2";
  return reviewerAvailable(rungs) ? "rung_3" : "takeover";
}

/** Runs rungs 1 to 3 over one trouble (section 5 §8.4, §8.7, §8.8), in order: declared outcomes,
 * handlers, retry, climb; then jev, then the reviewer. A model is asked only on a climb, with the
 * helper window open, and only through `deps.rungs` (never otherwise).
 */
export async function runLadder(input: LadderInput, deps: LadderDeps): Promise<LadderResult> {
  const window = helperWindow(input.trouble.risk, input.trouble.dispatched);
  // Why: section 5 §8.2, "Rung 2 jev: skipped; Rung 3 reviewer: skipped" while the window is closed.
  const rungs = window === "open" ? deps.rungs : undefined;

  const climb = (): LadderResult => {
    const data: LadderLogData = { rung: 1, verdict: "climb", window, matched: [], handler: null, attempt: 1, next: "takeover", resume_at: null, files: input.captureFiles };
    logLadder(deps, input.stepId, data, { kind: "engine_rule", ref: "window.closed" });
    return { kind: "climb", log: data };
  };

  /** A climb that may go on to rung 2 or 3. `tied` are the handlers rung 1 could not choose between. */
  const climbUp = async (observation: Observation, tied: readonly string[]): Promise<LadderResult> => {
    const next = nextAfterRung1(rungs);
    if (rungs === undefined || next === "takeover") return climb();
    const data: LadderLogData = { rung: 1, verdict: "climb", window, matched: [], handler: null, attempt: 1, next, resume_at: null, files: input.captureFiles };
    logLadder(deps, input.stepId, data, { kind: "engine_rule", ref: "climb" });
    return await higherRungs(rungs, input, deps, window, observation, tied);
  };

  if (input.limits.ladderEntriesUsed >= LADDER_ENTRIES_PER_RUN) return climb();

  const observed = await deps.eyes.observe(deps.signal);
  if (!observed.ok) {
    const data: LadderLogData = { rung: 1, verdict: "hard_failure", window, matched: [], handler: null, attempt: 1, next: "end", resume_at: null, files: input.captureFiles };
    logLadder(deps, input.stepId, data, { kind: "engine_rule", ref: "engine_rule" });
    return { kind: "hard_failure", code: "session_lost", message: "the screen went away while the ladder was deciding", transient: false, ladderRef: "engine_rule", log: data };
  }
  const screen = fromObservation(observed.value);

  // Step 2: declared outcomes (section 5 §8.4 step 2). A single, unraced check: the checkpoint
  // race already ran once inside the step; this catches an outcome that only shows once trouble
  // already started (like a precondition failure that is itself the business answer).
  for (const outcome of input.stepOutcomes) {
    const matches = passes(outcome.condition, screen, deps.taskCtx);
    logCheck(deps, input.stepId, "sweep", outcome.condition, matches);
    if (matches) {
      const data: LadderLogData = { rung: 1, verdict: "business_outcome", window, matched: [], handler: null, attempt: 1, next: "end", resume_at: null, files: input.captureFiles };
      logLadder(deps, input.stepId, data, { kind: "engine_rule", ref: "outcome.declared" });
      return { kind: "business_outcome", code: outcome.code, log: data };
    }
  }

  // Step 3: handlers.
  const matched = matchDetectors(deps.frozen.handlers, screen, deps.packCtx);
  for (const id of matched) logCheck(deps, input.stepId, "handler", id, true);
  if (matched.length > 0) {
    const winner = matched.length === 1 && matched[0] !== undefined ? { winner: matched[0] } : breakTie(matched, deps.frozen);
    if ("tied" in winner) return await climbUp(observed.value, matched);
    const handler = deps.frozen.handlers.find((h) => h.id === winner.winner);
    if (handler === undefined) throw new Error(`runLadder: matched handler ${winner.winner} is not in the frozen set`);
    return await applyHandler(handler, matched, window, input, deps);
  }

  // Step 4: retry. No match, window open, trouble not `target_ambiguous` (section 5 §8.4 step 4).
  if (window === "open" && !input.trouble.ambiguous && input.limits.retriesUsedThisStep < RETRY_MAX_PER_STEP) {
    const isTransport = input.trouble.transportEvent !== null;
    const retryRef = isTransport ? "retry.transport" : "retry.idempotent";
    if (isTransport) {
      await deps.gate.act(
        { actor: "engine", lease: deps.lease, action: { type: "navigate", to: deps.lastGoodPath }, step: input.stepId },
        deps.signal,
      );
    }
    const fresh = await deps.eyes.observe(deps.signal);
    if (fresh.ok) {
      const freshScreen = fromObservation(fresh.value);
      const resumed = resumeSearch(input.steps, input.stepIndex, input.trouble.dispatched, input.floorIndex, freshScreen, deps.taskCtx);
      if (resumed.kind !== "not_recovered") {
        const index = landingIndex(resumed, input.stepIndex);
        const resumeAtId = input.steps[index]?.id ?? input.stepId;
        const data: LadderLogData = {
          rung: 1,
          verdict: "recovered",
          window,
          matched: [],
          handler: null,
          attempt: input.limits.retriesUsedThisStep + 1,
          next: "resume_at",
          resume_at: resumeAtId,
          files: input.captureFiles,
        };
        logLadder(deps, input.stepId, data, { kind: "engine_rule", ref: retryRef });
        return { kind: "recovered", index, recovery: { via: "retry", ref: retryRef, resumedAt: resumeAtId }, log: data };
      }
    }
  }

  // Step 5: known screen, no progress (docs/decisions.md, M06: a location-only precondition
  // never counts as known; that case climbs instead).
  if (input.limits.retriesUsedThisStep >= RETRY_MAX_PER_STEP) {
    const failedStep = input.steps[input.stepIndex];
    const stillKnown =
      failedStep !== undefined &&
      passes(failedStep.precondition, screen, deps.taskCtx) &&
      !isLocationOnly(failedStep.precondition, deps.taskCtx.conditions ?? new Map<string, Condition>());
    if (stillKnown) {
      const transient = input.trouble.code === "app_error" || input.trouble.code === "service_unavailable";
      const data: LadderLogData = { rung: 1, verdict: "hard_failure", window, matched: [], handler: null, attempt: 1, next: "end", resume_at: null, files: input.captureFiles };
      logLadder(deps, input.stepId, data, { kind: "engine_rule", ref: "retry_limit" });
      return { kind: "hard_failure", code: input.trouble.code, message: input.trouble.message, transient, ladderRef: "retry_limit", log: data };
    }
  }

  // Step 6: otherwise climb.
  return await climbUp(observed.value, []);
}

/** Applies the winning handler's class (section 5 §8.4 step 3, §6.2). `mark` is set when jev
 * picked the handler (section 5 §8.7): the lines say rung 2, and the handler keeps all its limits. */
async function applyHandler(
  handler: Handler,
  matched: readonly string[],
  window: Window,
  input: LadderInput,
  deps: LadderDeps,
  mark?: RungMark,
): Promise<LadderResult> {
  const attempt = (input.limits.handlerAttemptsThisStep[handler.id] ?? 0) + 1;

  if (handler.class === "business_outcome") {
    const declared = input.stepOutcomes.some((o) => o.code === handler.outcome.code);
    const data: LadderLogData = { rung: 1, verdict: declared ? "business_outcome" : "hard_failure", window, matched, handler: handler.id, attempt, next: "end", resume_at: null, files: input.captureFiles, ...mark };
    logLadder(deps, input.stepId, data, { kind: "handler", ref: handler.id });
    if (declared) {
      // Why: section 3 §5.8, `decided_by: jev` when jev, not a matched detector, chose the handler.
      return { kind: "business_outcome", code: handler.outcome.code, ...(mark === undefined ? {} : { decidedBy: "jev" as const }), log: data };
    }
    return {
      kind: "hard_failure",
      code: "undeclared_outcome",
      message: `the app showed a known state this capability does not declare: ${handler.description}`,
      transient: false,
      ladderRef: "outcome_not_declared",
      log: data,
    };
  }

  if (handler.class === "hard_failure") {
    const data: LadderLogData = { rung: 1, verdict: "hard_failure", window, matched, handler: handler.id, attempt, next: "end", resume_at: null, files: input.captureFiles, ...mark };
    logLadder(deps, input.stepId, data, { kind: "handler", ref: handler.id });
    return { kind: "hard_failure", code: handler.failure, message: handler.description, transient: HARD_FAILURE_TRANSIENT[handler.failure], ladderRef: handler.id, log: data };
  }

  if (handler.class === "needs_human") {
    const data: LadderLogData = { rung: 1, verdict: "needs_human", window, matched, handler: handler.id, attempt, next: "takeover", resume_at: null, files: input.captureFiles, ...mark };
    logLadder(deps, input.stepId, data, { kind: "handler", ref: handler.id });
    return { kind: "needs_human", operatorNote: handler.operator_note, log: data };
  }

  // handler.class === "recoverable": only class that acts, and only with the window open
  // (section 5 §8.2: "recoverable handlers: No" when the window is closed).
  if (window === "closed") {
    deps.log({ event: "action", step: input.stepId, by: "handler", why: { kind: "handler", ref: handler.id }, data: { type: "response", ok: false, warning: "handler_matched_not_run" } });
    const data: LadderLogData = { rung: 1, verdict: "climb", window, matched, handler: handler.id, attempt, next: "takeover", resume_at: null, files: input.captureFiles, ...mark };
    logLadder(deps, input.stepId, data, { kind: "handler", ref: handler.id });
    return { kind: "climb", log: data };
  }

  const stepCap = Math.min(handler.limits.per_step, HANDLER_ATTEMPTS_PER_STEP);
  const runCap = Math.min(handler.limits.per_run, HANDLER_ATTEMPTS_PER_RUN);
  const usesSignIn = handler.response.some((a) => a.type === "sign_in");
  const exhausted =
    (input.limits.handlerAttemptsThisStep[handler.id] ?? 0) >= stepCap ||
    input.limits.handlerAttemptsThisRun >= runCap ||
    (usesSignIn && input.limits.signInRunsUsed >= SIGN_IN_RUNS_PER_RUN);
  if (exhausted) return applyOnExhausted(handler, matched, window, attempt, input, deps, mark);

  if (handler.delay_ms !== undefined) await deps.clock.after(handler.delay_ms, deps.signal);
  const responseDeps: ResponseDeps = {
    eyes: deps.eyes,
    gate: deps.gate,
    clock: deps.clock,
    redactor: deps.redactor,
    lease: deps.lease,
    refs: deps.taskCtx.refs,
    packTargets: deps.packTargets,
    lastGoodPath: deps.lastGoodPath,
    runPrelude: deps.runPrelude,
    step: input.stepId,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  };
  const ranOk = await runResponse(handler.response, responseDeps);
  logHandlerAction(deps, input.stepId, handler.id, handler.response[0]?.type ?? "response", ranOk);
  if (!ranOk) return applyOnExhausted(handler, matched, window, attempt, input, deps, mark);

  if (handler.done_when !== undefined) {
    const doneScreen = await deps.eyes.observe(deps.signal);
    const done = doneScreen.ok && passes(handler.done_when, fromObservation(doneScreen.value), deps.packCtx);
    if (!done) return applyOnExhausted(handler, matched, window, attempt, input, deps, mark);
  }

  const fresh = await deps.eyes.observe(deps.signal);
  if (!fresh.ok) return applyOnExhausted(handler, matched, window, attempt, input, deps, mark);
  const freshScreen = fromObservation(fresh.value);
  const resumed = resumeSearch(input.steps, input.stepIndex, input.trouble.dispatched, input.floorIndex, freshScreen, deps.taskCtx);
  if (resumed.kind === "not_recovered") return applyOnExhausted(handler, matched, window, attempt, input, deps, mark);

  const index = landingIndex(resumed, input.stepIndex);
  const resumeAtId = input.steps[index]?.id ?? input.stepId;
  const data: LadderLogData = { rung: 1, verdict: "recovered", window, matched, handler: handler.id, attempt, next: "resume_at", resume_at: resumeAtId, files: input.captureFiles, ...mark };
  logLadder(deps, input.stepId, data, { kind: "handler", ref: handler.id });
  return { kind: "recovered", index, recovery: { via: mark === undefined ? "handler" : "jev", ref: handler.id, resumedAt: resumeAtId }, log: data };
}

/** A `recoverable` handler's `on_exhausted` (section 5 §6.6): either a fixed hard failure, or a
 * takeover with the author's own note. */
function applyOnExhausted(
  handler: Extract<Handler, { class: "recoverable" }>,
  matched: readonly string[],
  window: Window,
  attempt: number,
  input: LadderInput,
  deps: LadderDeps,
  mark?: RungMark,
): LadderResult {
  if (handler.on_exhausted.class === "hard_failure") {
    const code = handler.on_exhausted.failure;
    const data: LadderLogData = { rung: 1, verdict: "hard_failure", window, matched, handler: handler.id, attempt, next: "end", resume_at: null, files: input.captureFiles, ...mark };
    logLadder(deps, input.stepId, data, { kind: "handler", ref: handler.id });
    return { kind: "hard_failure", code, message: handler.description, transient: HARD_FAILURE_TRANSIENT[code], ladderRef: "on_exhausted", log: data };
  }
  const data: LadderLogData = { rung: 1, verdict: "needs_human", window, matched, handler: handler.id, attempt, next: "takeover", resume_at: null, files: input.captureFiles, ...mark };
  logLadder(deps, input.stepId, data, { kind: "handler", ref: handler.id });
  return { kind: "needs_human", operatorNote: handler.on_exhausted.operator_note, log: data };
}

/**
 * Rungs 2 and 3, after a rung 1 climb with the window open (section 5 §8.7, §8.8): jev sorts the
 * trouble; if it cannot, the reviewer proposes one action. `tied` are the handlers rung 1 could
 * not choose between. Anything neither rung resolves climbs to rung 4.
 */
async function higherRungs(
  rungs: RungDeps,
  input: LadderInput,
  deps: LadderDeps,
  window: Window,
  observation: Observation,
  tied: readonly string[],
): Promise<LadderResult> {
  const step = input.steps[input.stepIndex];
  const facts = rungs.steps.get(input.stepId);
  if (step === undefined || facts === undefined) throw new Error(`runLadder: no facts for step ${input.stepId}`);
  const troubleFacts: TroubleFacts = {
    r: deps.redactor,
    observation,
    step,
    stepIndex: input.stepIndex,
    steps: input.steps,
    facts,
    trouble: input.trouble,
    conditions: deps.taskCtx.conditions,
    lastGoodPath: deps.lastGoodPath,
  };
  const line = (rung: 2 | 3, verdict: Verdict, next: LadderLogData["next"], resumeAt: string | null, extra: Partial<LadderLogData>): LadderLogData => ({
    rung,
    verdict,
    window,
    matched: tied,
    handler: null,
    attempt: 1,
    next,
    resume_at: resumeAt,
    files: input.captureFiles,
    ...extra,
  });

  // Rung 2: jev (section 5 §8.7).
  let hint: ReviewerInput["jev"] = null;
  if (rungs.jev !== null) {
    const rec = rungs.recorder("jev");
    const call = await rungs.jev.trouble(
      jevTroubleInput(troubleFacts, { outcomes: input.stepOutcomes, handlers: deps.frozen.handlers, tied }),
      rec.record,
      deps.signal,
    );
    const verdict = troubleVerdict(
      call,
      { outcomes: input.stepOutcomes.map((o) => o.code), handlers: deps.frozen.handlers.map((h) => h.id) },
      rungs.cutoffs,
    );
    if (verdict.kind === "needs_review" && verdict.warning !== undefined) {
      logWarning(deps, input.stepId, verdict.warning, call.ok ? "jev named something this step does not offer, or broke its format" : `the jev call failed: ${call.failure}`);
    }
    const mark = (bucket: string, threshold?: number): RungMark => ({
      rung: 2,
      bucket,
      confidence: verdict.confidence,
      ...(threshold === undefined ? {} : { threshold }),
      input: rec.request,
    });

    if (verdict.kind === "outcome") {
      // Why: section 5 §8.7. The outcome is one this step declares (checked in `troubleVerdict`),
      // and it ends the run only as a business outcome; a model never reports `refused`.
      const data = line(2, "business_outcome", "end", null, mark("outcome", rungs.cutoffs.outcome_min));
      logLadder(deps, input.stepId, data, { kind: "classifier", ref: "outcome" });
      return { kind: "business_outcome", code: verdict.code, decidedBy: "jev", log: data };
    }
    if (verdict.kind === "handler") {
      const handler = deps.frozen.handlers.find((h) => h.id === verdict.handler);
      if (handler === undefined) throw new Error(`runLadder: jev's handler ${verdict.handler} is not in the frozen set`);
      // Why: section 5 §8.7, "jev may pick a handler whose detector did not match."
      if (!tied.includes(handler.id)) logWarning(deps, input.stepId, "detector_missed", `jev picked ${handler.id}, but its detector did not match`, handler.id);
      return await applyHandler(handler, tied, window, input, deps, mark("handler", rungs.cutoffs.handler_min));
    }
    if (verdict.kind === "unsafe") {
      // Why: section 5 §8.7, "unsafe: any confidence"; when unsure, assume the worst.
      const data = line(2, "needs_human", "takeover", null, mark("unsafe"));
      logLadder(deps, input.stepId, data, { kind: "classifier", ref: "unsafe" });
      return { kind: "unsafe", log: data };
    }
    hint = call.ok && verdict.warning === undefined ? { bucket: call.value.bucket, confidence: call.value.confidence } : null;
    const next = reviewerAvailable(rungs) ? "rung_3" : "takeover";
    const data = line(2, "climb", next, null, mark("needs_review"));
    logLadder(deps, input.stepId, data, { kind: "classifier", ref: "needs_review" });
    if (next === "takeover") return { kind: "climb", log: data };
  }

  // Rung 3: the reviewer (section 5 §8.8, §11).
  const reviewer = rungs.reviewer;
  const stuck = (ref: string, input3: string): LadderResult => {
    const data = line(3, "climb", "takeover", null, { input: input3 });
    logLadder(deps, input.stepId, data, { kind: "llm_reason", ref });
    return { kind: "climb", log: data };
  };
  if (reviewer === null || !reviewerAvailable(rungs)) return stuck("unavailable", "");
  rungs.onReviewerCall();
  const rec = rungs.recorder("reviewer");
  const shot = rungs.sendScreenshots ? await maskedScreenshot(deps.eyes, deps.redactor, deps.signal) : null;
  if (shot !== null && !shot.ok) logWarning(deps, input.stepId, "screenshot_withheld", shot.failure);
  const built = reviewerInput(troubleFacts, {
    hint,
    inputs: [...rungs.inputs.keys()],
    allowed: rungs.allowed,
    commit: rungs.commit(),
    shot: shot !== null && shot.ok ? shot.value : null,
  });
  const call = await reviewer.fixStep(built.input, rec.record, deps.signal);
  // Why every failure is "stuck": section 5 §8.8, "anything else: takeover, reason `stuck`".
  if (!call.ok) return stuck(call.failure, rec.request);
  if ("give_up" in call.value) return stuck("give_up", rec.request);
  const fix = call.value;
  const gateAction = reviewerGateAction(fix.action, built.refs, rungs.inputs);
  if (gateAction === null) return stuck("unknown_element", rec.request);
  const proposed = await deps.gate.act({ actor: "reviewer", lease: deps.lease, action: gateAction, step: input.stepId }, deps.signal);
  if (!proposed.ok) return stuck(proposed.failure, rec.request);
  if (proposed.value.decision !== "allowed") {
    // Why: section 5 §11.3 step 1, "Blocked: takeover, `unsafe_state`."
    const data = line(3, "needs_human", "takeover", null, { input: rec.request });
    logLadder(deps, input.stepId, data, { kind: "llm_reason", ref: proposed.value.rule });
    return { kind: "unsafe", log: data };
  }
  if (proposed.value.act?.dispatched === false) return stuck("not_dispatched", rec.request);
  // Why read before the log call: `log.append` takes its number at once, so this is the line's own.
  const seq = rungs.nextSeq();
  deps.log({ event: "action", step: input.stepId, by: "reviewer", why: { kind: "llm_reason", ref: fix.reason }, data: { type: fix.action.type, ok: true, expected: fix.expected } });

  // Landing (section 5 §11.3 steps 2 to 5): the step's checkpoint or its precondition must show,
  // within the step's timeout. No wider rewind: the reviewer is the least trusted helper.
  const waited = await waitForCondition(
    { check: "any_of", checks: [{ ref: step.checkpoint }, { ref: step.precondition }] },
    deps.eyes,
    deps.taskCtx,
    facts.timeoutMs,
    deps.clock,
    deps.signal,
  );
  if (!waited.ok) return stuck("page_gone", rec.request);
  const landing = checkpointLanding(step, input.trouble.dispatched, passes(step.checkpoint, waited.value.screen, deps.taskCtx));
  if (landing === "human") return stuck("irreversible_not_sent", rec.request);
  const onCheckpoint = landing === "next";
  if (!onCheckpoint && !passes(step.precondition, waited.value.screen, deps.taskCtx)) return stuck("no_landing", rec.request);
  const index = onCheckpoint ? input.stepIndex + 1 : input.stepIndex;
  const resumeAt = input.steps[index]?.id ?? step.id;

  // Why `patch_needed`: section 5 §11.4, the step's own action on another control, and the checkpoint passed.
  logWarning(deps, input.stepId, onCheckpoint && fix.action.type === facts.action ? "patch_needed" : "handler_needed", `the reviewer fixed ${input.stepId} (line ${String(seq)})`);
  const data = line(3, "recovered", "resume_at", resumeAt, { input: rec.request });
  logLadder(deps, input.stepId, data, { kind: "llm_reason", ref: fix.reason });
  return { kind: "recovered", index, recovery: { via: "reviewer", ref: `seq:${String(seq)}`, resumedAt: resumeAt }, log: data };
}
