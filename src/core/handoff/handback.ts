// Forward search: after a handback, find the step the bot resumes at, crediting the human only
// for steps they finished. Follows design section 7 §16.2 (the search), §16.3 (the human moved
// past the outputs) and section 5 §8.6 (the resume rule, which the executor applies if this finds
// nothing). Pure: it reads one screen, once, with no wait, and acts on nothing.
import { evaluate, type EvalCtx } from "../targets/evaluate.js";
import type { ScreenView } from "../targets/screen.js";

/** The part of a step the search needs. `isRead` marks a `read` step (it fills an output). */
export type HandbackStep = { id: string; precondition: string; checkpoint: string; isRead: boolean };

/** What the search reads. `commitIndex` is `null` when the capability has no commit step. */
export type ForwardFacts = {
  steps: readonly HandbackStep[];
  /** The step the takeover opened on. */
  stuckIndex: number;
  commitIndex: number | null;
  /** True when the commit is `confirmed` (section 7 §16.2, "crossing the commit point needs it"). */
  commitConfirmed: boolean;
  /** True when the commit is in any state but `not_sent`. Then no step at or before the commit
   * step may be the resume step: replay never sends an irreversible step twice. */
  commitSent: boolean;
  /** The screen as it is now. */
  screen: ScreenView;
  ctx: EvalCtx;
};

/** What forward search found: a step to resume at, the human-moved-past-outputs case, or nothing. */
export type ForwardResult =
  | { kind: "found"; index: number }
  | { kind: "past_outputs" }
  | { kind: "none" };

/**
 * Section 7 §16.2. From the last step down to the one after the stuck step, stopping at the first
 * `read` step (the bot reads outputs itself, so it never skips one). A step K qualifies when its
 * precondition passes now AND the step before it has its checkpoint passing now (rule 2: fills on
 * one form all pass their screen condition, so only a checkpoint proves a step done). The latest
 * qualifying K wins. A K past the commit step needs the commit `confirmed`.
 *
 * `past_outputs` is section 7 §16.3: the commit is confirmed and the read step after it no longer
 * has its precondition (the human left the confirmation page), so the outputs come from the
 * reconciliation check.
 */
export function forwardSearch(f: ForwardFacts): ForwardResult {
  const passes = (id: string): boolean => evaluate({ check: "ref", ref: id }, f.screen, f.ctx) === "true";
  const firstRead = f.steps.findIndex((s, i) => i >= f.stuckIndex && s.isRead);
  // Why the read step is the top: a step the human "finished" past it would lose the output.
  const top = firstRead === -1 ? f.steps.length - 1 : firstRead;
  const crossesCommit = (k: number): boolean =>
    f.commitIndex !== null && f.stuckIndex <= f.commitIndex && k > f.commitIndex;
  for (let k = top; k > f.stuckIndex; k--) {
    if (crossesCommit(k) && !f.commitConfirmed) continue;
    // Why: section 7 §16.1 and CLAUDE.md, "never retry an irreversible step; after the commit
    // point, go forward only". A sent commit step is never a resume step.
    if (f.commitSent && f.commitIndex !== null && k <= f.commitIndex) continue;
    const here = f.steps[k];
    const before = f.steps[k - 1];
    if (here !== undefined && before !== undefined && passes(here.precondition) && passes(before.checkpoint)) {
      return { kind: "found", index: k };
    }
  }
  const read = firstRead === -1 ? undefined : f.steps[firstRead];
  if (
    read !== undefined &&
    f.commitConfirmed &&
    f.commitIndex !== null &&
    firstRead > f.commitIndex &&
    !passes(read.precondition)
  ) {
    return { kind: "past_outputs" };
  }
  return { kind: "none" };
}
