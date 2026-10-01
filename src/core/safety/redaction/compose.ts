// Joins masked pieces with fixed text written in code, such as element IDs, braces, and field
// names. Follows design section 9 §5.1 (only redaction makes Masked values) and section 4 §10.1
// (the model sees the masked view). Screen text never goes through the redactor twice.
import type { Masked } from "../../../ports/masked.js";
import type { PlannerTool, PlannerTurn } from "../../../ports/models.js";
import type { Png } from "../../../ports/surface.js";

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
  // Why a cast: cutting or swapping characters in masked text reveals nothing new.
  return quoteScreenText(text) as Masked<string>;
}

/**
 * The same cleaning for text a caller already holds as a plain string (a model prompt built from
 * a `Masked` input): one line, `"` as `'`, `<` `>` as `‹` `›`, cut at `max` characters.
 */
export function quoteScreenText(text: string, max: number = MAX_NAME): string {
  const safe = text
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll('"', "'")
    .replaceAll("<", "‹")
    .replaceAll(">", "›");
  return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
}

/** Indents one masked line by `depth` levels of two spaces. */
export function indent(line: Masked<string>, depth: number): Masked<string> {
  // Why a cast: leading spaces reveal nothing.
  return `${"  ".repeat(depth)}${line}` as Masked<string>;
}

/** A planner turn's parts, each already masked. Tools come from code (section 9 §5.3). */
export type TurnParts = {
  model: string;
  prompt: string;
  system: Masked<string>;
  tools: readonly PlannerTool[];
  message: Masked<string>;
  image: Masked<Png> | null;
};

/** Brands one planner turn. Every screen-derived part is masked already, so the whole is. */
export function maskedTurn(parts: TurnParts): Masked<PlannerTurn> {
  // Why a cast: the brand has no runtime form; the parts' types prove the masking.
  const turn: PlannerTurn = { ...parts };
  return turn as Masked<PlannerTurn>;
}

/**
 * Brands the exact bytes of one model call for `llm/` (section 9 §5.3). A request holds only a
 * masked turn plus the provider's framing. A reply holds only what the model wrote, and the
 * model saw only the masked view (section 4 §10.3).
 */
export function wireBytes(bytes: Uint8Array): Masked<Uint8Array> {
  return bytes as Masked<Uint8Array>;
}
