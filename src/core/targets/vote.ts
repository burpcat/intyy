// Clue voting: finds the one screen element a target means, or says there is none, or more than
// one. Follows design section 7 §6 (candidates, `within`, weights, agree/differ/missing, minimum
// evidence, the winner rule) and section 2 §13 (targets and clues).
import type { RoleGroup } from "../../ports/surface.js";
import type { Clues, Target } from "../model/artifact/targets.js";
import { descendantsOf, type ScreenElement, type ScreenView } from "./screen.js";
import { containsClue, resolveRefs, sameClue } from "./text.js";

/** A clue name that takes part in scoring (`role` is a gate, not a scored clue). */
type ClueName = "name" | "label" | "text" | "region" | "image" | "path";

/** Clue weights (section 7 §6.3). */
const WEIGHT: Record<ClueName, number> = {
  name: 0.3,
  label: 0.25,
  text: 0.2,
  region: 0.1,
  image: 0.1,
  path: 0.05,
};

/** Clues whose agreement counts toward the evidence floor's second rule (section 7 §6.5). */
const EVIDENCE_CLUES = new Set<ClueName>(["name", "label", "text", "image"]);

/** The role group each recorded role clue falls in (section 7 §6.1). This mirrors the design
 * table's static cases; the port's own classifier (section 4 §7.4) also weighs DOM facts a
 * saved role string cannot carry, like whether a role-less element is clickable. A role this
 * table does not list is never guessed into a group: {@link vote} falls back to an exact role
 * match instead, so an unmapped role still filters, without silently excluding the element it
 * was recorded from (a `container` default would do that for a wrongly-classed candidate). */
const ROLE_GROUP: Readonly<Record<string, RoleGroup>> = {
  button: "button_like",
  menuitem: "button_like",
  menuitemcheckbox: "button_like",
  menuitemradio: "button_like",
  textbox: "text_entry",
  searchbox: "text_entry",
  spinbutton: "text_entry",
  combobox: "choice",
  listbox: "choice",
  checkbox: "check",
  radio: "check",
  switch: "check",
  link: "navigation",
  tab: "navigation",
  treeitem: "navigation",
  row: "container",
  cell: "container",
  gridcell: "container",
  table: "container",
  grid: "container",
  list: "container",
  listitem: "container",
  form: "container",
  dialog: "container",
  alertdialog: "container",
};

/** The role group a target's `role` clue means, or `undefined` when the table does not list it. */
function roleGroupOf(role: string): RoleGroup | undefined {
  return ROLE_GROUP[role];
}

/** Euclidean distance between two centers, in fractions of the viewport. */
function centerDistance(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  return Math.hypot(ax - bx, ay - by);
}

/** 1 within 3% of the viewport, falling linearly to 0 at 20% (section 7 §6.3, `region`). */
function regionDegree(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const dist = centerDistance(a, b);
  if (dist <= 0.03) return 1;
  if (dist >= 0.2) return 0;
  return 1 - (dist - 0.03) / (0.2 - 0.03);
}

/** 1 when equal; 0.5 when the last three ` > `-separated parts match; else 0 (section 7 §6.3, `path`). */
function pathDegree(a: string, b: string): number {
  if (a === b) return 1;
  const lastParts = (p: string): string => p.split(">").map((part) => part.trim()).slice(-3).join(">");
  return lastParts(a) === lastParts(b) ? 0.5 : 0;
}

/** One candidate's score and the clues that agreed, differed, or were missing (section 7 §6.4,
 * §6.5, §6.8). "Agreeing" includes a partial match (`region`, `path`); "differing" is zero.
 * Only clues the target recorded take part (§6.4, last bullet). Picture likeness is M08: until
 * then `image` is always missing on the candidate side, so it never scores.
 */
function scoreOf(
  clues: Clues,
  el: ScreenElement,
  refs: ReadonlyMap<string, string> | undefined,
): {
  score: number;
  meetsEvidence: boolean;
  agreeing: ClueName[];
  differing: ClueName[];
  missing: ClueName[];
} {
  let weightTotal = 0;
  let weightAgree = 0;
  const agreeing: ClueName[] = [];
  const differing: ClueName[] = [];
  const missing: ClueName[] = [];
  const add = (name: ClueName, degree: number | null): void => {
    if (degree === null) {
      missing.push(name);
      return;
    }
    weightTotal += WEIGHT[name];
    weightAgree += WEIGHT[name] * degree;
    (degree > 0 ? agreeing : differing).push(name);
  };

  if (clues.name !== undefined) {
    add("name", el.name === undefined ? null : sameClue(el.name, resolveRefs(clues.name, refs)) ? 1 : 0);
  }
  if (clues.label !== undefined) {
    add(
      "label",
      el.label === undefined ? null : sameClue(el.label, resolveRefs(clues.label, refs)) ? 1 : 0,
    );
  }
  if (clues.text !== undefined) {
    add(
      "text",
      el.text === undefined ? null : containsClue(el.text, resolveRefs(clues.text, refs)) ? 1 : 0,
    );
  }
  if (clues.region !== undefined) {
    add("region", el.region === undefined ? null : regionDegree(clues.region, el.region));
  }
  if (clues.image !== undefined) add("image", null); // M08: no pixel comparison yet.
  if (clues.path !== undefined) add("path", pathDegree(resolveRefs(clues.path, refs), el.path));

  const score = weightTotal === 0 ? 0 : weightAgree / weightTotal;
  const meetsEvidence = weightAgree >= 0.2 && agreeing.some((n) => EVIDENCE_CLUES.has(n));
  return { score, meetsEvidence, agreeing, differing, missing };
}

/** The facts one vote logs (section 7 §6.8). */
export type VoteFacts = {
  candidates: number;
  winner: string | null;
  /** The top-scoring candidate, win or not: whose `agreeing`/`differing`/`missing` these are.
   * Null only when there were no candidates to score (section 3 §6.4, differing clue values). */
  bestElementId: string | null;
  score: number | null;
  margin: number | null;
  agreeing: readonly string[];
  differing: readonly string[];
  missing: readonly string[];
};

/** One target's vote result (section 7 §6.6): the winning element's ID, or that none or more
 * than one candidate fit. */
export type VoteResult =
  | { kind: "winner"; elementId: string; facts: VoteFacts }
  | { kind: "not_found"; facts: VoteFacts }
  | { kind: "ambiguous"; facts: VoteFacts };

const EMPTY_FACTS: VoteFacts = {
  candidates: 0,
  winner: null,
  bestElementId: null,
  score: null,
  margin: null,
  agreeing: [],
  differing: [],
  missing: [],
};

/**
 * Finds the one screen element `target` means (section 7 §6). `within` votes for the parent
 * target first; a parent that is not found or ambiguous makes the child the same (§6.2).
 */
export function vote(
  target: Target,
  screen: ScreenView,
  targetsById: ReadonlyMap<string, Target>,
  refs?: ReadonlyMap<string, string>,
): VoteResult {
  let pool: readonly ScreenElement[] = screen.elements;
  if (target.within !== undefined) {
    const parent = targetsById.get(target.within);
    if (parent === undefined) {
      throw new Error(`target ${target.id}: within ${target.within} is not a known target`);
    }
    const parentVote = vote(parent, screen, targetsById, refs);
    if (parentVote.kind !== "winner") return { kind: parentVote.kind, facts: EMPTY_FACTS };
    const within = descendantsOf(screen, parentVote.elementId);
    pool = screen.elements.filter((e) => within.has(e.id) && e.id !== parentVote.elementId);
  }
  if (target.clues.role !== undefined) {
    const role = target.clues.role;
    const group = roleGroupOf(role);
    // Why: an unmapped role has no group to compare; fall back to an exact role match rather
    // than a guessed group, so it still filters without excluding the element it was for.
    pool = group === undefined ? pool.filter((e) => e.role === role) : pool.filter((e) => e.roleGroup === group);
  }

  const scored = pool.map((el) => ({ el, ...scoreOf(target.clues, el, refs) }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best === undefined) return { kind: "not_found", facts: { ...EMPTY_FACTS, candidates: 0 } };
  const second = scored[1];
  const margin = best.score - (second?.score ?? 0);
  const facts: VoteFacts = {
    candidates: scored.length,
    winner: best.score >= 0.7 && best.meetsEvidence ? best.el.id : null,
    bestElementId: best.el.id,
    score: best.score,
    margin,
    agreeing: best.agreeing,
    differing: best.differing,
    missing: best.missing,
  };
  if (best.score < 0.7 || !best.meetsEvidence) return { kind: "not_found", facts };
  if (margin < 0.15) return { kind: "ambiguous", facts };
  return { kind: "winner", elementId: best.el.id, facts };
}
