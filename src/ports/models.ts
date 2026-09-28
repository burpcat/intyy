// The model ports: planner, classifier, and reviewer. Masked inputs only.
// Follows design section 9 §5.3.
import type { Masked } from "./masked.js";
import type { Opaque } from "./opaque.js";
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
/** jev's trouble input. Section 5 §10. M09. */
export type JevTroubleInput = Opaque<"JevTroubleInput">;
/** jev's trouble output. Section 5 §10. M09. */
export type JevTroubleOutput = Opaque<"JevTroubleOutput">;
/** jev's reconcile input. Section 5 §10. M09. */
export type JevReconcileInput = Opaque<"JevReconcileInput">;
/** jev's reconcile output. Section 5 §10. M09. */
export type JevReconcileOutput = Opaque<"JevReconcileOutput">;
/** The reviewer's fix-step input. Section 5 §11. M09. */
export type ReviewerInput = Opaque<"ReviewerInput">;
/** The reviewer's fix-step output. Section 5 §11. M09. */
export type ReviewerOutput = Opaque<"ReviewerOutput">;

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

/** jev, the error sorter on rung 2 (section 5 §10). A failure means `needs_review`, confidence 0. */
export interface Classifier {
  /** Sorts one piece of trouble. */
  trouble(
    input: Masked<JevTroubleInput>,
    signal?: AbortSignal,
  ): Promise<Outcome<JevTroubleOutput, ModelFailure>>;
  /** Judges one reconciliation check. */
  reconcile(
    input: Masked<JevReconcileInput>,
    signal?: AbortSignal,
  ): Promise<Outcome<JevReconcileOutput, ModelFailure>>;
}

/** The reviewer LLM on rung 3 (section 5 §11). A failure means a takeover, `stuck`. */
export interface Reviewer {
  /** Proposes a fix for one step. */
  fixStep(
    input: Masked<ReviewerInput>,
    signal?: AbortSignal,
  ): Promise<Outcome<ReviewerOutput, ModelFailure>>;
  /** Gives a second opinion on a reconciliation check. */
  secondOpinion(
    input: Masked<JevReconcileInput>,
    signal?: AbortSignal,
  ): Promise<Outcome<JevReconcileOutput, ModelFailure>>;
}
