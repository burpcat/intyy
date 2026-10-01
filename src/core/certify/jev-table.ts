// The jev table: pooled, labelled jev calls, counted per answer type as right, wrong, or below
// threshold. Pure counting; the calls come from certify reports (M10 pools them).
// Follows design section 8 §8.5 (jev answers and truth) and section 9 §9.5 (`jev report`).
// `jevCallsOf` labels a drill's jev reconcile answers by the drill's known truth (section 8 §14.2).
import type { JevCall } from "../model/batch-report.js";
import { labelCall } from "../trust/autonomy.js";

/** The answer types a jev call can have (section 5 §10.3, §10.5). */
export const ANSWER_TYPES = [
  "handler",
  "outcome",
  "needs_review",
  "unsafe",
  "found",
  "not_found",
  "unclear",
] as const;

/** One jev answer type. */
export type AnswerType = (typeof ANSWER_TYPES)[number];

/** How a labelled call counts (section 8 §8.5): right, wrong, or below the threshold. */
export type CallLabel = "right" | "wrong" | "below_threshold";

/** One jev call with its truth label. */
export type LabelledCall = { jev_version: string; answer: AnswerType; label: CallLabel };

/** One table row: the counts for one answer type. */
export type JevRow = { answer: AnswerType } & Record<CallLabel, number>;

/** Counts calls per answer type. Every answer type gets a row, even at zero, so the table shape never changes. */
export function jevTable(calls: readonly LabelledCall[]): JevRow[] {
  return ANSWER_TYPES.map((answer) => {
    const row: JevRow = { answer, right: 0, wrong: 0, below_threshold: 0 };
    for (const c of calls) if (c.answer === answer) row[c.label] += 1;
    return row;
  });
}

/**
 * The jev reconcile answers in one drill run's log, each labelled by the drill's known truth
 * (section 8 §14.2: "correct when the oracle agrees"). Only `by: jev` lines count: the reviewer's second opinion is not jev's answer.
 * An answer that is not `found`, `not_found`, or `unclear` is skipped.
 */
export function jevCallsOf(
  drill: { case_id: string; run_id: string; truth: JevCall["truth"] },
  lines: readonly unknown[],
): JevCall[] {
  const out: JevCall[] = [];
  for (const raw of lines) {
    if (typeof raw !== "object" || raw === null) continue;
    const line = raw as { event?: unknown; by?: unknown; data?: { verdict?: unknown } };
    if (line.event !== "reconciliation" || line.by !== "jev") continue;
    const answer = line.data?.verdict;
    if (answer !== "found" && answer !== "not_found" && answer !== "unclear") continue;
    out.push({ ...drill, answer, label: labelCall(answer, drill.truth) });
  }
  return out;
}
