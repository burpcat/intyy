// Verdicts: what a case's result class and truth checks add up to.
// Follows design section 8 §6.3 (the expected-ending rules), §8.1, and §8.3.
import type { Verdict } from "../model/batch-report.js";
import type { ExpectRule } from "../model/faults.js";
import type { CheckMode } from "../model/artifact/recovery.js";
import type { CommitState } from "../model/result.js";

/** What a case's result class amounts to (section 8 §8.1): status, plus one detail. `detail` is
 * an outcome code, a failure code, or `<kind>/<reason>/<step>` for `escalated`. */
export type ResultClass = { status: "success" | "business_outcome" | "failed" | "escalated"; detail: string | null };

/** What `judgeCase` needs to pick a verdict (section 8 §8.1, §8.3). `certify case` and `certify
 * rerun` never run stability, so `explained` never applies here (section 8 §8.3: "Stability
 * only"). */
export type JudgeInput = {
  /** Does the run's result class match the case's expected result (status, and its detail)? */
  classMatches: boolean;
  /** Every truth check that ran (section 8 §8.2). `null` ("unavailable") never fails a case. */
  truth: { commit?: boolean | null; output?: boolean | null; outcome?: boolean | null };
  /** Help the case did not expect actually happened (section 8 §8.3). Always `false` in M06:
   * rungs 2 and 3 are off, so nothing can help unexpectedly. */
  unexpectedHelp?: boolean;
  /** A harness error, a runner crash, or a missing step (section 8 §8.3). */
  void?: boolean;
};

/** Picks one verdict (section 8 §8.3). A failed truth check always wins: "Blocks approval,
 * always." */
export function judgeCase(input: JudgeInput): Verdict {
  if (input.void === true) return "void";
  const truthFailed = Object.values(input.truth).some((v) => v === false);
  if (truthFailed) return "wrong";
  if (!input.classMatches) return "unexplained";
  if (input.unexpectedHelp === true) return "assisted";
  return "pass";
}

/** The class's own expected result: the suite class's `expect`, read as a minimal result class
 * (section 8 §6.1's example: `{status, outcome?}`). */
type ClassExpect = { status: string; outcome?: unknown };

/** One `extra` case's own expected result (section 8 §6.1's example: escalated cases also name
 * `kind`, `reason`, and `step`). */
type ExtraExpect = { status: string; outcome?: unknown; kind?: unknown; reason?: unknown; step?: unknown };

/** Whether a result class matches a plain expectation object (status, and its one detail). */
function matchesPlainExpect(rc: ResultClass, expect: ClassExpect): boolean {
  if (rc.status !== expect.status) return false;
  if (rc.status === "business_outcome") return rc.detail === expect.outcome;
  return true;
}

/**
 * Translates one fault profile's expected-ending rule into a match against the run's result
 * class (section 8 §6.3's table). `commit` is the run's own reported commit state. `checkMode`
 * is the artifact's reconciliation check mode, `reference` when it has none.
 */
export function matchesExpectRule(
  rule: ExpectRule,
  rc: ResultClass,
  classExpect: ClassExpect,
  commit: CommitState | null,
  checkMode: CheckMode = "reference",
): boolean {
  if (rule === "recovers") return matchesPlainExpect(rc, classExpect);
  if (rule === "recovers_or_escalates") return matchesPlainExpect(rc, classExpect) || rc.status === "escalated";
  if (rule.startsWith("fails:")) return rc.status === "failed" && rc.detail === rule.slice("fails:".length);
  if (rule === "reconciles_found" && checkMode === "count_diff") {
    // Why: a count proves the commit but returns no outputs (owner decisions, 2026-10-01;
    // section 7 §11.1, "Found, but outputs missing").
    return rc.status === "failed" && rc.detail === "outputs_unavailable" && commit === "found_by_check";
  }
  if (rule === "reconciles_found") return rc.status === "success" && commit === "found_by_check";
  // `reconciles_absent`: success, commit confirmed, with an earlier `absent_by_check` attempt
  // already folded into `effect.attempts` by the executor (section 7 §11.3).
  return rc.status === "success" && commit === "confirmed";
}

/**
 * The expected ending of a commit-step fault on an artifact whose recovery is a waiver
 * (docs/decisions.md, M06; section 3 §5.12): escalated at a `reconciliation_decision`, reason
 * `reconciliation_waived`, commit `uncertain`. It replaces the profile's own commit-step rule,
 * which assumes a check (section 8 §6.3).
 */
export function matchesWaivedEnding(rc: ResultClass, commit: CommitState | null, commitStepId: string | null): boolean {
  return (
    rc.status === "escalated" &&
    rc.detail === `reconciliation_decision/reconciliation_waived/${commitStepId ?? ""}` &&
    commit === "uncertain"
  );
}

/** `x` when it is a string, else `""`. `expect`'s own fields are typed `unknown`, since a
 * suite's `expect` object is a loose Zod shape (section 8 §6.1). */
function asString(x: unknown): string {
  return typeof x === "string" ? x : "";
}

/** Whether a result class matches a suite `extra` case's own `expect` object exactly (section 8
 * §6.1's example): status, plus its outcome code or its escalation kind/reason/step. */
export function matchesExtraExpect(rc: ResultClass, expect: ExtraExpect): boolean {
  if (rc.status !== expect.status) return false;
  if (rc.status === "business_outcome") return rc.detail === expect.outcome;
  if (rc.status === "escalated") {
    return rc.detail === `${asString(expect.kind)}/${asString(expect.reason)}/${asString(expect.step)}`;
  }
  return true;
}
