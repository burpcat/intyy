// Format patterns: simple templates for an app's own ID shapes. No regular expressions.
// Follows design section 4 §9.8, "Format patterns (policy)".
import { fail, ok, type Outcome } from "../../../ports/outcome.js";

/** Escapes text for a regular expression in `u` mode. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Parses a format pattern into a regular expression that matches whole words, ignoring case.
 * `9` is a digit, `A` a letter, `X` a letter or digit. Anything else is itself.
 * Quotes make a literal: `"A"9999` matches `A1234`. Example: `SH99999999` matches `SH00481223`.
 */
export function parseIdFormat(format: string): Outcome<RegExp, "invalid"> {
  let source = "";
  let i = 0;
  while (i < format.length) {
    const c = format.charAt(i);
    if (c === '"') {
      const end = format.indexOf('"', i + 1);
      if (end === -1) return fail("invalid", "a quote in a format pattern has no closing quote");
      if (end === i + 1) return fail("invalid", "a format pattern holds an empty quote");
      source += escapeRegex(format.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === "9") source += "\\d";
    else if (c === "A") source += "[A-Za-z]";
    else if (c === "X") source += "[A-Za-z0-9]";
    else source += escapeRegex(c);
    i += 1;
  }
  return ok(new RegExp(`(?<![\\p{L}\\p{N}])${source}(?![\\p{L}\\p{N}])`, "giu"));
}
