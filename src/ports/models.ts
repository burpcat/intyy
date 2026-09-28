// The model ports: planner, classifier, and reviewer. Masked inputs only.
// Follows design section 9 §5.3.
import type { Masked } from "./masked.js";
import type { Opaque } from "./opaque.js";
import type { Outcome } from "./outcome.js";

/** Every expected model failure (section 9 §5.3). */
export type ModelFailure = "timeout" | "unavailable" | "refused" | "invalid_output";

/** One discovery turn sent to the planner. Section 6. M03. */
export type PlannerTurn = Opaque<"PlannerTurn">;
/** The planner's reply. Section 6. M03. */
export type PlannerReply = Opaque<"PlannerReply">;
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

/** The discovery LLM (section 6). One retry, then `model_unavailable`. */
export interface Planner {
  /** Asks for the next discovery move. */
  next(
    turn: Masked<PlannerTurn>,
    signal?: AbortSignal,
  ): Promise<Outcome<PlannerReply, ModelFailure>>;
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
