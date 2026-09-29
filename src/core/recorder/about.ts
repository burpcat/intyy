// Recorder step 14 (section 6 §14.2, §14.14): `about`, and `provenance`'s runs, actions, and
// decisions.
import type { About } from "../model/artifact/identity.js";
import type {
  Decision as ArtifactDecision,
  DecisionWhat as ArtifactDecisionWhat,
  ProvenanceAction,
  ProvenanceRun,
  RunKind,
} from "../model/artifact/provenance.js";
import type { CandidateDecision, CandidateDecisionWhat } from "../model/candidate-decision.js";
import type { RunSpec } from "../model/runspec.js";
import type { TaggedAction } from "./tags.js";
import { actionSubject } from "./tags.js";

/** One `{input.*}` reference in a goal string. */
const INPUT_REF = /\{input\.([a-z0-9_]+)\}/g;

/** The goal, with each input reference replaced by that input's own description (section 6
 * §14.14: "the goal, with references replaced by input descriptions"). */
function describedGoal(spec: RunSpec): string {
  return spec.goal.replace(INPUT_REF, (whole, name: string) => {
    const input = spec.inputs.find((i) => i.name === name);
    return input === undefined ? whole : input.description;
  });
}

/**
 * `about` (section 2 §11, section 6 §14.14). `title` comes from the capability name.
 * `when_to_use` and `limits` stay empty: a human writes them (blocking issue, section 6 §14.15).
 */
export function buildAbout(spec: RunSpec): About {
  const words = spec.capability.split("_").filter((w) => w !== "");
  const first = words[0];
  const title = first === undefined ? spec.capability : `${first.charAt(0).toUpperCase()}${first.slice(1)} ${words.slice(1).join(" ")}`.trim();
  return { title, summary: describedGoal(spec), when_to_use: "", limits: "" };
}

/** One `provenance.runs` entry (section 2 §17.2). */
export function buildProvenanceRun(
  spec: RunSpec,
  runId: string,
  kind: RunKind,
  recorderVersion: string,
): ProvenanceRun {
  const out: ProvenanceRun = {
    run_id: runId,
    kind,
    goal: spec.goal,
    model: spec.model,
    recorder_version: recorderVersion,
  };
  if (spec.expected_outcome !== undefined) out.expected_outcome = spec.expected_outcome.code;
  return out;
}

/**
 * `provenance.actions` (section 2 §17.3): one entry per raw action, with its tags and fate.
 * `becameOf` names what it became; the caller knows that only once steps and drafts exist.
 */
export function buildProvenanceActions(
  tagged: readonly TaggedAction[],
  decisions: readonly CandidateDecision[],
  becameOf: (a: TaggedAction) => string,
): ProvenanceAction[] {
  const decidedBy = new Map<string, string>();
  for (const d of decisions) {
    if (d.what === "tag") decidedBy.set(d.subject, d.by);
  }
  return tagged.map((a) => ({
    run_id: a.runId,
    seq: a.seq,
    llm_tag: a.tag,
    human_tag: a.humanTag,
    decided_by: a.humanTag === null ? null : decidedBy.get(actionSubject(a.runId, a.seq)) ?? null,
    became: becameOf(a),
  }));
}

/** A candidate decision's `what`, folded onto the artifact's own, smaller list (section 2
 * §17.4): `recovery` becomes `edit`, since the artifact's own decisions carry no such kind. */
function toArtifactWhat(w: Exclude<CandidateDecisionWhat, "tag">): ArtifactDecisionWhat {
  return w === "recovery" ? "edit" : w;
}

/**
 * `provenance.decisions` (section 2 §17.4), from the candidate's own decision log. `tag`
 * decisions are dropped: they already live in `provenance.actions[].human_tag` and
 * `decided_by`. `note` is dropped too: it lives only in `decisions.jsonl` (docs/decisions.md, M04).
 */
export function buildProvenanceDecisions(decisions: readonly CandidateDecision[]): ArtifactDecision[] {
  return decisions
    .filter((d): d is CandidateDecision & { what: Exclude<CandidateDecisionWhat, "tag"> } => d.what !== "tag")
    .map((d) => ({ what: toArtifactWhat(d.what), subject: d.subject, value: d.value, by: d.by, at: d.at }));
}
