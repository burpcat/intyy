// Display formats for `type` and `read`: a date or money value shown the way the app wants.
// Follows design section 6 §7.4 (the fixed format lists) and section 2 §12.3 (value types).
// The LLM never sees the value; it names a format, and plain code applies it.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A `YYYY-MM-DD` date in `format`, like `MM/DD/YYYY`. Null when the date does not parse. */
export function formatDate(value: string, format: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y = "", mo = "", d = ""] = m;
  const parts: Record<string, string> = {
    YYYY: y,
    YY: y.slice(2),
    MMM: MONTHS[Number(mo) - 1] ?? "",
    MM: mo,
    DD: d,
  };
  return format.replace(/YYYY|YY|MMM|MM|DD/g, (t) => parts[t] ?? t);
}

/**
 * A money value like `1250.00` in `format`: `0.00`, `#,##0.00`, or `0`. Null when it does not
 * parse, or when `0` would drop cents that are not zero (section 6 §7.4).
 */
export function formatMoney(value: string, format: string): string | null {
  const m = /^(\d+)\.(\d{2})$/.exec(value);
  if (!m) return null;
  const [, whole = "", cents = ""] = m;
  switch (format) {
    case "0.00":
      return `${whole}.${cents}`;
    case "#,##0.00":
      return `${whole.replace(/\B(?=(\d{3})+$)/g, ",")}.${cents}`;
    case "0":
      return cents === "00" ? whole : null;
    default:
      return null;
  }
}
