// Recorder step 5 (section 6 §14.2, §14.5): preconditions and checkpoints, and the rules that
// keep a condition's text stable across runs.
//
// Simplification (ponytail: input is the run's masked log lines only, not its saved snapshot
// files): a `click`/`press`/`navigate` checkpoint is "the next step's screen condition" per
// §14.5, without the extra "one new landmark" the full design adds by diffing two saved
// snapshots. The last step's checkpoint, which §14.5 builds from `done.proof`, falls back to
// the observed location after the action: the log never captures a fingerprint for a `done`
// call's proof elements, only for elements a tool acted on. Upgrade path: read the run's saved
// `a11y/*.yaml` snapshots too, and pass their text in alongside the log lines.
import type { Condition, NestedCheck } from "../model/artifact/conditions.js";

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
