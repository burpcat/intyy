// Text normalizing, matching, and reference resolving for clues and conditions.
// Follows design section 2 §7.3 (wildcards) and §7.4 (text matching).
import type { z } from "zod";
import { MatchKind } from "../model/artifact/conditions.js";

/** `text_visible`/`field_value`'s `match` field (section 2 §14.4). */
type Match = z.infer<typeof MatchKind>;

/** Trims, collapses runs of spaces to one, and lower-cases unless `caseSensitive` (section 2 §7.4). */
export function normalizeText(text: string, caseSensitive = false): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return caseSensitive ? collapsed : collapsed.toLowerCase();
}

/** True when two target clue values are the same, after normalizing (section 2 §13.2: `name`
 * and `label` "match exactly, after normalization"). Always case-insensitive: a clue has no
 * `case_sensitive` field. */
export function sameClue(a: string, b: string): boolean {
  return normalizeText(a) === normalizeText(b);
}

/** True when `haystack` contains `needle`, after normalizing both (section 2 §13.2, `text`:
 * "matches if the control's text contains the clue"). */
export function containsClue(haystack: string, needle: string): boolean {
  return normalizeText(haystack).includes(normalizeText(needle));
}

/** Escapes one character for use inside a `RegExp` source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `value` matches a wildcard `pattern`, where `*` matches any one or more characters,
 * even `/` (section 2 §7.3: "text and version fields keep the plain rule"). Unlike a path
 * pattern, this never restricts `*` to stop at a slash.
 */
function wildcardMatches(value: string, pattern: string, caseSensitive: boolean): boolean {
  const v = normalizeText(value, caseSensitive);
  const p = normalizeText(pattern, caseSensitive);
  const source = p.split("*").map(escapeRegExp).join(".+");
  return new RegExp(`^${source}$`).test(v);
}

/** Matches `value` against a condition's `text_visible` or `field_value` pattern, by `match`
 * kind (section 2 §14.4: `exact`, `contains`, `wildcard`). */
export function matchText(
  value: string,
  pattern: string,
  match: Match,
  caseSensitive = false,
): boolean {
  if (match === "wildcard") return wildcardMatches(value, pattern, caseSensitive);
  const v = normalizeText(value, caseSensitive);
  const p = normalizeText(pattern, caseSensitive);
  return match === "exact" ? v === p : v.includes(p);
}

/** One `{input.*}` or `{secret.*}` reference, as it appears in a clue or a condition value. */
const REF = /\{([a-z][a-z0-9_]*\.[a-z0-9_]+)\}/gi;

/**
 * Replaces every `{input.*}` reference in `text` with its raw value from `refs` (section 7 §6.3:
 * "References in clues use the raw value, in memory only. It is never logged."). An unresolved
 * reference is left as is; the loader checks that every reference is declared.
 */
export function resolveRefs(text: string, refs: ReadonlyMap<string, string> | undefined): string {
  if (refs === undefined) return text;
  return text.replace(REF, (whole: string, key: string) => refs.get(key) ?? whole);
}
