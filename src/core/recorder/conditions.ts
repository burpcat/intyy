// Recorder step 5 (section 6 §14.2, §14.5): preconditions and checkpoints, and the rules that
// keep a condition's text stable across runs.
import type { Condition, NestedCheck } from "../model/artifact/conditions.js";
import type { ScreenElement, ScreenView } from "../targets/screen.js";

/** A leaf or combined check, with no `id` or `description` (section 2 §14.5). */
export type NestedLeaf = ReturnType<typeof NestedCheck.parse>;

/** One `{output.*}` reference (section 4 §9.6), which a checkpoint text always replaces with
 * `*` (section 6 §14.5): the output's value is unknown until the run reads it. */
const OUTPUT_REF = /\{output\.[a-z0-9_]+\}/g;

/** One mask token, kept out of a condition too (section 6 §14.5). */
const MASK_TOKEN = /\[[a-z]+#\d+\]/g;

/** A date or a time of day, replaced with `*` (section 6 §14.5): CONTRACT's last-login time,
 * for one example, follows the real clock and never repeats. */
const DATE_OR_TIME = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:[AaPp][Mm])?\b/g;

/**
 * Keeps a condition's text stable across runs (section 6 §14.5): a mask token, an output
 * reference, or a date or time becomes `*`; an `{input.*}` reference is kept, since it is a
 * parameter, not an observed fact.
 */
export function stabilize(text: string): string {
  return text.replace(MASK_TOKEN, "*").replace(OUTPUT_REF, "*").replace(DATE_OR_TIME, "*");
}

/** `location` (section 2 §14.3). */
export function locationCheck(pattern: string): NestedLeaf {
  return { check: "location", pattern };
}

/** `element_visible` (section 2 §14.3). */
export function elementVisibleCheck(target: string): NestedLeaf {
  return { check: "element_visible", target };
}

/** `field_value` (section 2 §14.3, §14.4). A secret's checkpoint checks only that something was
 * typed, never the value (section 6 §14.5: "Secrets: `*` only"). */
export function fieldValueCheck(
  target: string,
  value: string,
  format?: string,
): NestedLeaf {
  const secret = /^\{secret\.[a-z0-9_]+\}$/.test(value);
  const out: NestedLeaf = secret
    ? { check: "field_value", target, value: "*", match: "wildcard" }
    : { check: "field_value", target, value: stabilize(value), match: "exact" };
  if (!secret && format !== undefined) return { ...out, format };
  return out;
}

/** `element_state` (section 2 §14.3, §14.4). */
export function elementStateCheck(
  target: string,
  state: "checked" | "unchecked" | "enabled" | "disabled" | "selected",
): NestedLeaf {
  return { check: "element_state", target, state };
}

/** `text_visible` (section 2 §14.3, §14.4). Its text is stabilized like any checkpoint value
 * (section 6 §14.5). */
export function textVisibleCheck(text: string, within?: string): NestedLeaf {
  const out: NestedLeaf = { check: "text_visible", text: stabilize(text), match: "contains" };
  return within === undefined ? out : { ...out, within };
}

/** One `role\u0000words` key for a landmark candidate: a heading or a plain text element with
 * words (section 6 §14.5, "a heading or text"). `null` for anything else. */
function landmarkKey(e: ScreenElement): string | null {
  if (e.role !== "heading" && e.role !== "text") return null;
  const words = e.text ?? e.name;
  return words === undefined || words.trim() === "" ? null : `${e.role}\u0000${words}`;
}

/**
 * Headings or text present in `after` and absent from `before` (section 6 §14.5, "found by
 * comparing the two snapshots"), in `after`'s own order.
 */
export function newLandmarks(before: ScreenView, after: ScreenView): string[] {
  const seen = new Set<string>();
  for (const e of before.elements) {
    const key = landmarkKey(e);
    if (key !== null) seen.add(key);
  }
  const out: string[] = [];
  for (const e of after.elements) {
    const key = landmarkKey(e);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    out.push(key.slice(key.indexOf("\u0000") + 1));
  }
  return out;
}

/**
 * The masked text on one turn's element-list line for `elementId` (section 6 §14.5, "last
 * checkpoint from proof"). `elementListText` is that turn's screen text, in the same
 * `e<n> role "name"` form the LLM saw (`buildScreen`, `src/core/discovery/observation.ts`).
 * `null` when the element has no line, or the line names no words (section 6 §8.2's `(no name)`).
 */
export function findProofText(elementListText: string, elementId: string): string | null {
  const lineRe = new RegExp(`^\\s*${elementId}\\s+(.*)$`, "m");
  const line = lineRe.exec(elementListText)?.[1];
  if (line === undefined) return null;
  return /"([^"]*)"/.exec(line)?.[1] ?? null;
}

/** One check, or every check joined by `all_of` when there is more than one. */
export function allOf(checks: readonly NestedLeaf[]): NestedLeaf {
  const first = checks[0];
  if (checks.length === 1 && first !== undefined) return first;
  return { check: "all_of", checks: [...checks] };
}

/**
 * Names and collects conditions, reusing one ID for two steps whose check is exactly the same
 * shape (section 2 §21's worked example: `type_username` and `type_password` both precondition
 * on `login_page_shown`).
 */
export class ConditionRegistry {
  readonly #byShape = new Map<string, string>();
  readonly #byId = new Set<string>();
  readonly #conditions: Condition[] = [];

  /** Starts with `existing` already interned, so a later `intern` call never clashes with, or
   * duplicates, a condition another rule group already built (`record.ts` shares one registry
   * across steps and outcomes this way). */
  constructor(existing: readonly Condition[] = []) {
    for (const c of existing) {
      const check: Record<string, unknown> = { ...c };
      delete check.id;
      delete check.description;
      this.#byId.add(c.id);
      this.#byShape.set(JSON.stringify(check), c.id);
      this.#conditions.push(c);
    }
  }

  /** Adds `check` under `idHint` (numbered on a clash), or reuses an identical check's ID. */
  intern(check: NestedLeaf, idHint: string, description: string): string {
    const shape = JSON.stringify(check);
    const existing = this.#byShape.get(shape);
    if (existing !== undefined) return existing;
    let id = idHint;
    for (let n = 2; this.#byId.has(id); n++) id = `${idHint}_${String(n)}`;
    this.#byId.add(id);
    this.#byShape.set(shape, id);
    this.#conditions.push({ ...check, id, description });
    return id;
  }

  /** Every condition interned so far, in first-seen order. */
  list(): readonly Condition[] {
    return this.#conditions;
  }
}
