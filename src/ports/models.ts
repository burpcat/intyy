// The model ports: planner, classifier, and reviewer. Masked inputs only.
// Follows design section 9 §5.3.
import type { Masked } from "./masked.js";
import type { Outcome } from "./outcome.js";

/** Every expected model failure (section 9 §5.3). */
export type ModelFailure = "timeout" | "unavailable" | "refused" | "invalid_output";

/** One tool the planner may call: name, one-line description, and JSON Schema (section 6 §9). */
export type PlannerTool = { name: string; description: string; input_schema: unknown };

/**
 * One discovery turn sent to the planner (section 6 §11). Every text is the masked view.
 * `system` and `tools` are the same bytes every turn, so the provider can cache them (§11.3).
 */
export type PlannerTurn = {
  /** The model ID, like `claude-sonnet-5`. Frozen per run. */
  model: string;
  /** The prompt version, like `discovery@1.0`. */
  prompt: string;
  system: string;
  tools: readonly PlannerTool[];
  message: string;
  /** The marked screenshot as PNG bytes, or null when withheld or not sent. */
  image: Uint8Array | null;
};

/** The planner's reply: its one tool call, or null when it gave none (a bad call, §11.3). */
export type PlannerReply = {
  call: { name: string; input: unknown } | null;
  /** The model that answered, as the provider names it. */
  model: string;
  usage: { input_tokens: number; output_tokens: number };
};

/**
 * Writes one call's exact bytes to the run's `llm/` folder: the request before it is sent,
 * the reply once it arrives (section 9 §5.3). False: the write failed, so nothing is sent.
 */
export type CallRecorder = (part: "request" | "reply", bytes: Uint8Array) => Promise<boolean>;

/** One element in the masked list jev and the reviewer read: role and name only (section 5 §10.2). */
export type ModelElement = { role: string; name: string };

/** A failed condition and its check trace (section 5 §10.2, `expected`). Every text is masked. */
export type ModelExpected = {
  condition: string;
  description: string;
  trace: readonly { path: string; check: string; passed: boolean }[];
};

/** The step that failed (section 5 §10.2, `step`). */
export type ModelStep = {
  id: string;
  intent: string;
  action: string;
  risk: "idempotent" | "reversible" | "irreversible";
  phase: string;
};

/** The last passed step and its location (section 5 §10.2, `last_good`). */
export type ModelLastGood = { step: string; location: string };

/**
 * What jev reads for one piece of step trouble: the masked screen and the choices (section 5
 * §10.2). `screenshot` is the format's optional field for surfaces with no accessibility text;
 * the build leaves it out. The stored file equals the sent input.
 */
export type JevTroubleInput = {
  schema: "intyy.jev.step/1.0";
  step: ModelStep;
  expected: ModelExpected;
  last_good: ModelLastGood | null;
  screen: { location: string; truncated: boolean; elements: readonly ModelElement[] };
  outcomes: readonly { code: string; description: string }[];
  handlers: readonly { id: string; class: string; description: string }[];
  tied: readonly string[];
  screenshot?: string | undefined;
};

/** jev's four buckets (section 5 §10.3). */
export type JevBucket = "outcome" | "handler" | "needs_review" | "unsafe";

/** jev's answer to step trouble (section 5 §10.3). `handler` and `outcome` are set for their bucket only. */
export type JevTroubleOutput = {
  bucket: JevBucket;
  handler: string | null;
  outcome: string | null;
  confidence: number;
};

/** What jev and the second opinion read for one reconciliation check (section 5 §10.5). */
export type JevReconcileInput = {
  schema: "intyy.jev.reconcile/1.0";
  parent: {
    capability: string;
    commit_step: { id: string; intent: string };
    correlation: "notes" | "none";
    last_screen: { location: string; elements: readonly ModelElement[] };
  };
  check: {
    capability: string;
    status: string;
    outcome: string | null;
    failure: {
      code: string;
      step: string;
      phase: string;
      trace: readonly { path: string; check: string; passed: boolean }[];
    } | null;
    final_screen: { location: string; elements: readonly ModelElement[] };
  };
  not_found_outcomes: readonly string[];
};

/** A reconciliation answer (section 5 §10.5). Below `reconciliation_min`, `found` and `not_found` count as `unclear`. */
export type JevReconcileOutput = {
  verdict: "found" | "not_found" | "unclear";
  confidence: number;
};

/** One element the reviewer may point at: an ID like `e4`, a role, and a name (section 5 §11.1). */
export type ReviewerElement = { id: string; role: string; name: string };

/**
 * What the reviewer reads for one stuck step (section 5 §11.1). `jev` is jev's bucket and
 * confidence as a hint, or null when rung 2 was off or skipped. `inputs` are input names only.
 * `screenshot` is the masked PNG as base64, or null when withheld.
 */
export type ReviewerInput = {
  schema: "intyy.reviewer.step/1.0";
  step: ModelStep;
  expected: ModelExpected;
  last_good: ModelLastGood | null;
  screen: { location: string; truncated: boolean; elements: readonly ReviewerElement[] };
  jev: { bucket: JevBucket; confidence: number } | null;
  inputs: readonly string[];
  allowed: { actions: readonly string[]; keys: readonly string[]; paths: readonly string[] };
  commit: "not_sent" | "confirmed";
  screenshot: string | null;
};

/** The one action the reviewer may propose (section 5 §11.2). The gate still checks it. */
export type ReviewerAction =
  | { type: "click"; element: string }
  | { type: "type"; element: string; value: string }
  | { type: "select"; element: string; value: string }
  | { type: "set_checked"; element: string; checked: boolean }
  | { type: "press"; key: string }
  | { type: "navigate"; location: string };

/** The reviewer's answer: one action with its reason and expectation, or a refusal (section 5 §11.2). */
export type ReviewerOutput =
  | { action: ReviewerAction; reason: string; expected: string }
  | { give_up: true; reason: string };

/** What a model-port call may fail with: the port's own failures, or an `llm/` write that failed first. */
export type CallFailure = ModelFailure | "write_failed";

/**
 * The discovery LLM (section 6). One retry, then `model_unavailable`. `write_failed`: the
 * recorder could not store the request, so it was never sent (section 9 §5.3).
 */
export interface Planner {
  /** Asks for the next discovery move. Stores the exact request bytes before sending them. */
  next(
    turn: Masked<PlannerTurn>,
    record: CallRecorder,
    signal?: AbortSignal,
  ): Promise<Outcome<PlannerReply, ModelFailure | "write_failed">>;
}

/**
 * jev, the error sorter on rung 2 (section 5 §10). A failure means `needs_review`, confidence 0.
 * Every call stores its request bytes first (section 9 §5.3); `write_failed` means nothing was sent.
 */
export interface Classifier {
  /** Sorts one piece of trouble. */
  trouble(
    input: Masked<JevTroubleInput>,
    record: CallRecorder,
    signal?: AbortSignal,
  ): Promise<Outcome<JevTroubleOutput, CallFailure>>;
  /** Judges one reconciliation check. */
  reconcile(
    input: Masked<JevReconcileInput>,
    record: CallRecorder,
    signal?: AbortSignal,
  ): Promise<Outcome<JevReconcileOutput, CallFailure>>;
}

/**
 * The reviewer LLM on rung 3 (section 5 §11). A failure means a takeover, `stuck`. Every call
 * stores its request bytes first (section 9 §5.3); `write_failed` means nothing was sent.
 */
export interface Reviewer {
  /** Proposes one action for one stuck step. */
  fixStep(
    input: Masked<ReviewerInput>,
    record: CallRecorder,
    signal?: AbortSignal,
  ): Promise<Outcome<ReviewerOutput, CallFailure>>;
  /** Gives a second opinion on a reconciliation check. Same input and output as jev's; no action. */
  secondOpinion(
    input: Masked<JevReconcileInput>,
    record: CallRecorder,
    signal?: AbortSignal,
  ): Promise<Outcome<JevReconcileOutput, CallFailure>>;
}
