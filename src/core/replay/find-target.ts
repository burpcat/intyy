// Finds a target's live element for replay, and the target_vote facts to log beside it.
// Follows design section 7 §6 (clue voting), §6.3 (references stay in memory only), §6.8 (what
// is logged), section 3 §6.4 (each differing clue's observed value), and section 4 §9.10
// (names only for button-like candidates, through the text rules).
import type { Masked } from "../../ports/masked.js";
import type { ElementRef, Observation } from "../../ports/surface.js";
import type { Target } from "../model/artifact/targets.js";
import type { Redactor } from "../safety/redaction/redactor.js";
import { elementOf, fromObservation, type ScreenElement } from "../targets/screen.js";
import { vote } from "../targets/vote.js";

/**
 * One differing clue, with its observed value for a patch draft (section 3 §6.4). `name`,
 * `label`, and `text` carry a value only for a button-like candidate (section 4 §9.10); a
 * differing clue on any other role logs its name alone.
 */
export type DifferingClue =
  | { clue: "name" | "label" | "text"; value?: Masked<string> }
  | { clue: "region"; value: { x: number; y: number; w: number; h: number } }
  | { clue: "path"; value: Masked<string> }
  // Why: M08 builds picture likeness. Until then `image` is always missing, never differing
  // (docs/decisions.md, M04), so this arm is unreachable today.
  | { clue: "image"; value: number };

/** The `target_vote` log line's data (section 7 §6.8). */
export type TargetVoteFacts = {
  candidates: number;
  winner: string | null;
  score: number | null;
  margin: number | null;
  agreeing: readonly string[];
  differing: readonly DifferingClue[];
  missing: readonly string[];
};

/** What `findTarget` answers: the live element, ready for `Hands.act`, or why there was none. */
export type FindTargetResult =
  | { kind: "winner"; ref: ElementRef; facts: TargetVoteFacts }
  | { kind: "not_found"; facts: TargetVoteFacts }
  | { kind: "ambiguous"; facts: TargetVoteFacts };

/** The observed value of one differing clue on the top-scoring candidate (section 3 §6.4). A
 * clue only reaches `differing` when that candidate actually carries it (vote.ts), so the
 * corresponding field is never missing here; a gap is a bug in that invariant, not trouble. */
function differingValue(clue: string, best: ScreenElement, redactor: Redactor): DifferingClue {
  const buttonLike = best.roleGroup === "button_like";
  if (clue === "name" || clue === "label" || clue === "text") {
    const raw = clue === "name" ? best.name : clue === "label" ? best.label : best.text;
    if (raw === undefined) throw new Error(`target_vote: ${clue} differed but is not observed`);
    return buttonLike ? { clue, value: redactor.text(raw) } : { clue };
  }
  if (clue === "region") {
    if (best.region === undefined) throw new Error("target_vote: region differed but is not observed");
    return { clue: "region", value: best.region };
  }
  if (clue === "path") return { clue: "path", value: redactor.text(best.path) };
  if (clue === "image") return { clue: "image", value: 0 };
  throw new Error(`target_vote: unknown clue ${clue}`);
}

/** The differing clues' observed values, or `[]` when there is nothing to differ from. */
function differingFacts(
  diffs: readonly string[],
  best: ScreenElement | undefined,
  redactor: Redactor,
): DifferingClue[] {
  if (diffs.length === 0) return [];
  if (best === undefined) throw new Error("target_vote: a differing clue with no top candidate");
  return diffs.map((clue) => differingValue(clue, best, redactor));
}

/**
 * Votes for `target` on a live `observation` (section 7 §6), and builds the `target_vote` facts
 * to log beside it. `refs` resolves `{input.*}` clues from raw values held in memory; they never
 * appear in `facts` (§6.3). The winner's `ref` stays valid until the next page change.
 */
export function findTarget(
  target: Target,
  observation: Observation,
  targetsById: ReadonlyMap<string, Target>,
  refs: ReadonlyMap<string, string> | undefined,
  redactor: Redactor,
): FindTargetResult {
  const screen = fromObservation(observation);
  const v = vote(target, screen, targetsById, refs);
  const best = v.facts.bestElementId === null ? undefined : elementOf(screen, v.facts.bestElementId);
  const facts: TargetVoteFacts = {
    candidates: v.facts.candidates,
    winner: v.facts.winner,
    score: v.facts.score,
    margin: v.facts.margin,
    agreeing: v.facts.agreeing,
    differing: differingFacts(v.facts.differing, best, redactor),
    missing: v.facts.missing,
  };
  if (v.kind !== "winner") return { kind: v.kind, facts };
  const el = observation.elements[Number(v.elementId)];
  if (el === undefined) throw new Error("target_vote: winner element id does not map back to the observation");
  return { kind: "winner", ref: el.ref, facts };
}
