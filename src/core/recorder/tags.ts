// Recorder step 2 (section 6 §14.2, §12.2): the human tag wins once decided, else the LLM tag.
// Then §14.3's keep rule: only `flow_step` actions become steps, and a `correction` drops both
// itself and the turn it names in `corrects` (section 6 §12.1).
import type { CandidateDecisionWhat } from "../model/candidate-decision.js";
import type { CollectedAction } from "./collect.js";
import type { ActionTag } from "./log-lines.js";
import type { RecorderIssue } from "./issues.js";

/** The parts of a candidate decision this module reads. */
export type TagDecision = { what: CandidateDecisionWhat; subject: string; value: string };

/** One action, tagged for real: the human tag if a reviewer decided one, else the LLM's own. */
export type TaggedAction = CollectedAction & {
  /** The reviewer's tag, or `null` before any tag decision (section 2 §17.3). */
  humanTag: ActionTag | null;
  /** The tag the recorder acts on: `humanTag` if decided, else `tag` (section 6 §12.2). */
  effectiveTag: ActionTag;
};

/** A decision's stable subject for one action: `<run_id>#<seq>` (docs/decisions.md, M04). */
export function actionSubject(runId: string, seq: number): string {
  return `${runId}#${String(seq)}`;
}

/** Applies each action's human tag decision, last one wins (section 2 §6.4). */
export function applyTags(
  actions: readonly CollectedAction[],
  decisions: readonly TagDecision[],
): TaggedAction[] {
  const bySubject = new Map<string, ActionTag>();
  for (const d of decisions) {
    if (d.what === "tag") bySubject.set(d.subject, d.value as ActionTag);
  }
  return actions.map((a) => {
    const humanTag = bySubject.get(actionSubject(a.runId, a.seq)) ?? null;
    return { ...a, humanTag, effectiveTag: humanTag ?? a.tag };
  });
}

/**
 * The actions that become steps (section 6 §14.3): tagged `flow_step`, minus any turn a kept
 * `correction` names in `corrects` (section 6 §12.1: "Drops it, and the named turn").
 */
export function keptActions(tagged: readonly TaggedAction[]): TaggedAction[] {
  const correctedTurns = new Set(
    tagged
      .filter((a) => a.effectiveTag === "correction")
      .map((a) => a.corrects)
      .filter((n): n is number => n !== null),
  );
  return tagged.filter((a) => a.effectiveTag === "flow_step" && !correctedTurns.has(a.turn));
}

/**
 * A blocking issue for each human action no reviewer has tagged yet (section 6 §10.5: "The
 * reviewer tags them"). Until then the action reads `exploration`, so it makes no step or draft.
 * The issue keeps the candidate from sealing on a silent drop.
 */
export function untaggedHumanIssues(tagged: readonly TaggedAction[]): RecorderIssue[] {
  return tagged
    .filter((a) => a.byHuman === true && a.humanTag === null)
    .map((a) => ({
      level: "blocking",
      code: "human_action_untagged",
      subject: actionSubject(a.runId, a.seq),
      message: `A person did ${a.tool} at t${String(a.turn)} during a takeover. Tag it flow_step, incidental, correction, or exploration.`,
    }));
}
