// The `read` tool: take one output from one element, convert it to its declared type, and hand
// back its reference. Follows design section 6 §9.3, §7.4 (formats), and section 2 §12.3 (types).
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { SurfaceElement } from "../../ports/surface.js";
import type { ValueType } from "../model/runspec.js";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A date shown in `format` back to `YYYY-MM-DD`, or null. */
export function parseDate(text: string, format: string): string | null {
  const tokens: string[] = [];
  const re = format.replace(/YYYY|YY|MMM|MM|DD|[.*+?^${}()|[\]\\]/g, (t) => {
    if (["YYYY", "YY", "MMM", "MM", "DD"].includes(t)) {
      tokens.push(t);
      return t === "YYYY" ? "(\\d{4})" : t === "MMM" ? "([A-Za-z]{3})" : "(\\d{2})";
    }
    return `\\${t}`;
  });
  const m = new RegExp(`^${re}$`).exec(text.trim());
  if (!m) return null;
  let y = "";
  let mo = "";
  let d = "";
  tokens.forEach((t, i) => {
    const v = m[i + 1] ?? "";
    if (t === "YYYY") y = v;
    else if (t === "YY") y = `20${v}`;
    else if (t === "MMM") mo = String(MONTHS.indexOf(v.toLowerCase()) + 1).padStart(2, "0");
    else if (t === "MM") mo = v;
    else d = v;
  });
  if (mo === "00" || y === "" || mo === "" || d === "") return null;
  return `${y}-${mo}-${d}`;
}

/** Converts read text to its type (section 2 §12.3). Null when it does not fit. */
export function convert(text: string, type: ValueType, format: string | undefined): string | null {
  const t = text.trim();
  switch (type) {
    case "string":
    case "enum":
      return t === "" ? null : t;
    case "integer": {
      const n = t.replace(/[,\s]/g, "");
      return /^-?\d+$/.test(n) ? n : null;
    }
    case "decimal": {
      const n = t.replace(/[,\s]/g, "");
      return /^-?\d+(\.\d+)?$/.test(n) ? n : null;
    }
    case "money": {
      // Why strings, not numbers: floating point loses cents (section 2 §12.3).
      const m = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(t.replace(/^USD\s*/i, ""));
      if (!m) return null;
      return `${(m[1] ?? "").replace(/,/g, "")}.${(m[2] ?? "").padEnd(2, "0")}`;
    }
    case "date":
      return format === undefined ? null : parseDate(t, format);
    case "boolean":
      return /^(true|yes)$/i.test(t) ? "true" : /^(false|no)$/i.test(t) ? "false" : null;
  }
}

/**
 * Reads one output (section 6 §9.3): the element's text or field value, then `pattern`'s first
 * group, then the type. A secret-filled field is never read (section 4 §8.6).
 */
export function readOutput(
  el: SurfaceElement,
  source: "text" | "value",
  pattern: string | undefined,
  type: ValueType,
  format: string | undefined,
): Outcome<{ raw: string; value: string }, "output_parse_failed"> {
  const raw =
    source === "value"
      ? el.field?.filled === true
        ? undefined
        : el.field?.value
      : (el.clues.text ?? el.clues.name);
  if (raw === undefined) return fail("output_parse_failed", `the element has no ${source}`);
  let picked = raw;
  if (pattern !== undefined) {
    const m = new RegExp(pattern).exec(raw);
    if (m === null) return fail("output_parse_failed", "the pattern did not match");
    picked = m[1] ?? m[0];
  }
  const value = convert(picked, type, format);
  return value === null ? fail("output_parse_failed", `not a ${type} value`) : ok({ raw, value });
}
