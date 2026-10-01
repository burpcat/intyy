// The certify gate: six rules, each a pure function of the batch's verdicts, so each can fail it alone.
// Follows design section 8 §9.5. A full batch accepts `pass` only (not `explained`, which is for stability).
import type { CaseGroup } from "../model/batch-plan.js";
import type { GateRules, Verdict } from "../model/batch-report.js";

/** One judged case, as the gate sees it. */
export type GateCase = { group: CaseGroup; verdict: Verdict };

/** What the gate reads (section 8 §9.5). */
export type GateInput = {
  kind: "full" | "quick" | "regression";
  /** A drill: instance facts differ from the test data set's, or `--models off` (section 8 §7.1). */
  drill: boolean;
  /** Every planned case ran to its end (section 8 §9.5 rule 1). False when the batch was cut short. */
  complete: boolean;
  cases: readonly GateCase[];
  /** Whether the baseline's twin pair has identical step traces. `null`: no twin pair ran. */
  twinMatch: boolean | null;
};

/** True when every case of the listed groups has the verdict `pass`. */
function allPass(cases: readonly GateCase[], groups: readonly CaseGroup[]): boolean {
  return cases.filter((c) => groups.includes(c.group)).every((c) => c.verdict === "pass");
}

/**
 * The six rules of section 8 §9.5, each on its own:
 * 1 `complete`: a `full` or `regression`, complete batch that is not a drill. Section 8 §15.1 asks a
 *   regression batch for rules 2 to 6 only; keeping the drill and complete checks on it is stricter, and a
 *   drill must never cover a pack (docs/decisions.md, M11).
 * 2 `no_wrong`: no `wrong` verdict anywhere.
 * 3 `baseline`: at least one baseline run, every baseline and twin run `pass`, and the twin pair's traces match.
 * 4 `matrix`: every matrix run `pass`.
 * 5 `extra`: every extra run `pass`.
 * 6 `no_void`: no case left `void`.
 * Drill cases (reconciliation evidence) sit under rules 2 and 6 only: they are judged on truth.
 */
export function gateRules(input: GateInput): GateRules {
  const { cases } = input;
  return {
    complete: (input.kind === "full" || input.kind === "regression") && !input.drill && input.complete,
    no_wrong: cases.every((c) => c.verdict !== "wrong"),
    baseline:
      cases.some((c) => c.group === "baseline") &&
      allPass(cases, ["baseline", "twin"]) &&
      input.twinMatch === true,
    matrix: allPass(cases, ["matrix"]),
    extra: allPass(cases, ["extra"]),
    no_void: cases.every((c) => c.verdict !== "void"),
  };
}

/** The gate passes when all six rules hold. */
export function gatePasses(rules: GateRules): boolean {
  return Object.values(rules).every((v) => v);
}
