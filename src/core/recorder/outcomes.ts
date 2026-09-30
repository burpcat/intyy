// Recorder step 8 (section 6 §14.2, §14.8): aligns a negative run with the positive run's
// steps, then builds its outcome from `report_outcome.proof`.
import type { ContractOutcome } from "../model/artifact/contract.js";
import type { Step, StepAction } from "../model/artifact/steps.js";
import type { Target } from "../model/artifact/targets.js";
import type { RunSpec } from "../model/runspec.js";
import { sameClue } from "../targets/text.js";
import { allOf, ConditionRegistry, proofChecks, type NestedLeaf } from "./conditions.js";
import type { RecorderIssue } from "./issues.js";
import type { Fingerprint } from "./log-lines.js";
import type { Snapshots } from "./steps.js";
import type { TaggedAction } from "./tags.js";

/** The tool and target one step's action names, for alignment (section 6 §14.8, "by target and
 * action type"). `null` target for a tool with none, like `press`. */
function toolAndTarget(action: StepAction): { tool: string; target: string | null } {
  switch (action.type) {
    case "press":
      return { tool: "press", target: null };
    case "navigate":
      return { tool: "navigate", target: null };
    default:
      return { tool: action.type, target: action.target };
  }
}

/** True when a negative run's acted control is the positive step's own target: the same role,
 * and the same words on whichever clue either side names first. */
function sameControl(fp: Fingerprint | null, target: Target | undefined): boolean {
  if (fp === null || target === undefined || fp.role !== target.clues.role) return false;
  const negWords = fp.name ?? fp.label ?? fp.text;
  const posWords = target.clues.name ?? target.clues.label ?? target.clues.text;
  return negWords !== null && posWords !== undefined && sameClue(negWords, posWords);
}

/**
 * Aligns the negative run's kept actions against the positive run's steps, action by action
 * (section 6 §14.8, point 1). Returns the last step both runs agree on, or `null` when not even
 * the first step aligns (a blocking review issue; a human attaches the outcome by hand).
 */
export function alignNegativeRun(
  negativeKept: readonly TaggedAction[],
  positiveSteps: readonly Step[],
  positiveTargets: readonly Target[],
): string | null {
  const targetById = new Map(positiveTargets.map((t) => [t.id, t]));
  let lastAligned: string | null = null;
  for (let i = 0; i < positiveSteps.length; i++) {
    const step = positiveSteps[i];
    const neg = negativeKept[i];
    if (step === undefined || neg === undefined) break;
    const { tool, target } = toolAndTarget(step.action);
    if (neg.tool !== tool) break;
    if (target !== null && !sameControl(neg.fingerprint, targetById.get(target))) break;
    lastAligned = step.id;
  }
  return lastAligned;
}

/** One negative run's outcome, drafted from `report_outcome.proof` (section 6 §14.8, points 2
 * to 4). `null` on a blocking issue: failed alignment, no `expected_outcome` in its spec, or the
 * proof text could not be found. */
export function buildOutcome(
  spec: RunSpec,
  alignedStepId: string | null,
  snapshots: Snapshots,
  registry: ConditionRegistry,
  issues: RecorderIssue[],
  targets: readonly Target[] = [],
): { stepId: string; outcome: ContractOutcome } | null {
  if (alignedStepId === null) {
    issues.push({
      level: "blocking",
      code: "failed_alignment",
      message: "The negative run does not align with any positive step; attach its outcome by hand.",
    });
    return null;
  }
  if (spec.expected_outcome === undefined) {
    issues.push({
      level: "blocking",
      code: "no_expected_outcome",
      message: "The negative run's spec names no expected outcome.",
    });
    return null;
  }
  const { code, description } = spec.expected_outcome;
  const checks = snapshots.proof === null ? null : proofChecks(snapshots.proofElementListText, snapshots.proof.ids, targets);
  if (checks === null) {
    issues.push({
      level: "blocking",
      code: "no_outcome_proof",
      subject: code,
      message: `${code}'s report_outcome proof text could not be found.`,
    });
    return null;
  }
  const check: NestedLeaf = allOf(checks);
  const conditionId = registry.intern(check, `${code}_shown`, description);
  return { stepId: alignedStepId, outcome: { code, description, condition: conditionId } };
}

/** Adds `code` to one step's `outcomes`, leaving every other step untouched (section 6 §14.8,
 * point 2: "It gets the outcome in `outcomes`"). */
export function attachOutcome(steps: readonly Step[], stepId: string, code: string): Step[] {
  return steps.map((s) =>
    s.id === stepId && !s.outcomes.includes(code) ? { ...s, outcomes: [...s.outcomes, code] } : s,
  );
}
