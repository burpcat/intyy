// Joins masked pieces with fixed text written in code, such as element IDs, braces, and field
// names. Follows design section 9 §5.1 (only redaction makes Masked values) and section 4 §10.1
// (the model sees the masked view). Screen text never goes through the redactor twice.
import type { Masked } from "../../../ports/masked.js";

/** One piece to join: masked text, a number, or a list of masked lines. */
export type Piece = Masked<string> | number | readonly Masked<string>[];

/**
 * A tagged template for masked text. The literal parts are code; every inserted piece must
 * already be masked. Example: masked`e${3} button "${name}"`. A list joins with new lines.
 * Why a template: masking a whole line again would re-read `label:"Member Number" value:` as
 * a label-value pair, and mask the value a second time (section 4 §9.7).
 */
export function masked(parts: TemplateStringsArray, ...pieces: readonly Piece[]): Masked<string> {
  let out = parts[0] ?? "";
  for (const [i, p] of pieces.entries()) {
    const text = typeof p === "number" ? String(p) : typeof p === "string" ? p : p.join("\n");
    out += text + (parts[i + 1] ?? "");
  }
  // Why a cast: the brand has no runtime form (section 9 §5.1).
  return out as Masked<string>;
}

/** The longest name the element list shows (section 6 §8.2). */
export const MAX_NAME = 80;

/**
 * Masked screen text made safe to quote in the element list: at most {@link MAX_NAME}
 * characters on one line, `"` as `'`, and `<` `>` as `‹` `›`. Why the last: page text must not close the
 * prompt's `<screen>` block and pose as intyy's own words (section 6 §11.1, section 4 §10.7).
 */
export function quoteScreen(text: Masked<string>): Masked<string> {
  const safe = text
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll('"', "'")
    .replaceAll("<", "‹")
    .replaceAll(">", "›");
  const clipped = safe.length > MAX_NAME ? `${safe.slice(0, MAX_NAME - 1)}…` : safe;
  // Why a cast: cutting or swapping characters in masked text reveals nothing new.
  return clipped as Masked<string>;
}

/** Indents one masked line by `depth` levels of two spaces. */
export function indent(line: Masked<string>, depth: number): Masked<string> {
  // Why a cast: leading spaces reveal nothing.
  return `${"  ".repeat(depth)}${line}` as Masked<string>;
}
