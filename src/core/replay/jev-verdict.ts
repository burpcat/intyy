// Turns one jev answer into a ladder verdict. Pure: bucket, confidence, thresholds, and what
// the step declares go in; a verdict comes out. No model call, no clock, no I/O.
// Follows design section 5 §8.7 (the bucket table), §10.4 (thresholds), §10.5, and §10.7 (when jev fails).
import type { Outcome } from "../../ports/outcome.js";
import type { CallFailure, JevReconcileOutput, JevTroubleOutput } from "../../ports/models.js";
import { JevReconcileOutput as ReconcileSchema, JevTroubleOutput as TroubleSchema } from "../model/jev.js";

/** The three confidence cutoffs for one app and jev version (section 5 §10.4, `intyy.thresholds/1.0`). */
export type Cutoffs = { handler_min: number; outcome_min: number; reconciliation_min: number };

/** A warning line code for a jev failure (section 5 §10.7). */
export type JevWarning = "classifier_unavailable" | "classifier_invalid_output";

/** What jev's step-trouble answer means for the ladder (section 5 §8.7). */
export type TroubleVerdict =
  | { kind: "outcome"; code: string; confidence: number }
  | { kind: "handler"; handler: string; confidence: number }
  /** Climb to rung 3. `warning` is set when jev failed or broke its format; confidence is then 0. */
  | { kind: "needs_review"; confidence: number; warning?: JevWarning }
  /** Takeover, reason `unsafe_state`, at any confidence (section 5 §8.7). */
  | { kind: "unsafe"; confidence: number };

/** What the step declares: outcome codes, and the frozen handler IDs (section 5 §10.7, "names an unknown handler"). */
export type TroubleChoices = { outcomes: readonly string[]; handlers: readonly string[] };

/** What jev's reconciliation answer means (section 5 §10.5): below `reconciliation_min` is `unclear`. */
export type ReconcileVerdict = {
  verdict: "found" | "not_found" | "unclear";
  confidence: number;
  warning?: JevWarning;
};

/**
 * The effective threshold: the higher of the app-level value and a context's tightening
 * (section 5 §10.4, "Effective threshold = the higher of the two"). A context holds tightenings only.
 */
export function effectiveThreshold(app: number, tightening: number | undefined): number {
  return tightening === undefined ? app : Math.max(app, tightening);
}

/** A jev failure as a verdict: `needs_review`, confidence 0, and the warning (section 5 §10.7). */
function broken(warning: JevWarning): TroubleVerdict {
  return { kind: "needs_review", confidence: 0, warning };
}

/** Which warning a failed call earns: a bad format is invalid output; the rest is "no answer". */
function warningFor(failure: CallFailure): JevWarning {
  return failure === "invalid_output" ? "classifier_invalid_output" : "classifier_unavailable";
}

/**
 * Rung 2's verdict for one answer (section 5 §8.7, §10.7). An answer below its threshold, or one
 * naming an unknown handler or an undeclared outcome, climbs as `needs_review` with confidence 0
 * and `classifier_invalid_output` for the unknown names. `>=` passes: a threshold is a minimum.
 */
export function troubleVerdict(
  call: Outcome<JevTroubleOutput, CallFailure>,
  choices: TroubleChoices,
  cutoffs: Pick<Cutoffs, "handler_min" | "outcome_min">,
): TroubleVerdict {
  if (!call.ok) return broken(warningFor(call.failure));
  // Why re-parse: the core owns the output schema (section 9 §5.3). An adapter or a fake that
  // hands back something off-format must still climb, never act.
  const parsed = TroubleSchema.safeParse(call.value);
  if (!parsed.success) return broken("classifier_invalid_output");
  const a = parsed.data;
  switch (a.bucket) {
    case "unsafe":
      return { kind: "unsafe", confidence: a.confidence };
    case "needs_review":
      return { kind: "needs_review", confidence: a.confidence };
    case "outcome":
      // Why: only a plain code decides "nothing changed", so jev's outcome is a business
      // outcome the step declared, never a commit state (CLAUDE.md, "a model never reports refused").
      if (a.outcome === null || !choices.outcomes.includes(a.outcome))
        return broken("classifier_invalid_output");
      return a.confidence >= cutoffs.outcome_min
        ? { kind: "outcome", code: a.outcome, confidence: a.confidence }
        : { kind: "needs_review", confidence: a.confidence };
    case "handler":
      if (a.handler === null || !choices.handlers.includes(a.handler))
        return broken("classifier_invalid_output");
      return a.confidence >= cutoffs.handler_min
        ? { kind: "handler", handler: a.handler, confidence: a.confidence }
        : { kind: "needs_review", confidence: a.confidence };
  }
}

/**
 * The verdict for one reconciliation answer (section 5 §10.5, §10.7). `found` and `not_found`
 * count only at `reconciliation_min` or more; the rest is `unclear`, which goes to a human.
 * Any failure is `unclear` with confidence 0. jev never says `refused`: its `not_found` only
 * asks for a human's retry decision (section 7 §11.3).
 */
export function reconcileVerdict(
  call: Outcome<JevReconcileOutput, CallFailure>,
  cutoffs: Pick<Cutoffs, "reconciliation_min">,
): ReconcileVerdict {
  if (!call.ok) return { verdict: "unclear", confidence: 0, warning: warningFor(call.failure) };
  const parsed = ReconcileSchema.safeParse(call.value);
  if (!parsed.success)
    return { verdict: "unclear", confidence: 0, warning: "classifier_invalid_output" };
  const a = parsed.data;
  if (a.verdict !== "unclear" && a.confidence < cutoffs.reconciliation_min)
    return { verdict: "unclear", confidence: a.confidence };
  return { verdict: a.verdict, confidence: a.confidence };
}
