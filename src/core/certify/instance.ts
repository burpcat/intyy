// Declared instance facts for a certify batch: parses `--instance k=v,…` and finds which facts
// differ from the test data set's `instance`. Follows design section 9 §9.2 ("Any difference
// from the default makes the batch a drill") and CONTRACT §4 (each option's type).
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { TestInstance } from "../model/testdata.js";

/** The facts a declaration may set (section 9 §9.2). */
const KEYS = ["variant", "strip_semantics", "drop_labels", "label_seed", "delay_scale"] as const;

/** A declaration: the facts as declared, and the names of those that differ from the default. */
export type Declared = { instance: TestInstance; differs: string[] };

/** A boolean fact, as `1`, `0`, `true`, or `false`. */
function parseFlag(v: string): boolean | undefined {
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return undefined;
}

/** A plain decimal number, else undefined (no `Infinity`, hex, or empty text). */
function parseNumber(v: string): number | undefined {
  return /^\d+(\.\d+)?$/.test(v) ? Number(v) : undefined;
}

/**
 * Parses `variant=lakeshore,strip_semantics=1,drop_labels=0.3,label_seed=7,delay_scale=0.2` over
 * `base` (the test data set's instance). An unknown key, a bad value, or a repeated key returns
 * `bad_instance` with the reason. `delay_scale` counts as 1 when `base` has none.
 */
export function declareInstance(text: string, base: TestInstance): Outcome<Declared, "bad_instance"> {
  const out: TestInstance = { ...base };
  const seen = new Set<string>();
  for (const pair of text.split(",")) {
    const cut = pair.indexOf("=");
    const key = pair.slice(0, cut);
    const value = pair.slice(cut + 1);
    if (cut <= 0 || value === "") return fail("bad_instance", `"${pair}" is not name=value`);
    if (!(KEYS as readonly string[]).includes(key)) {
      return fail("bad_instance", `${key} is not an instance fact; use ${KEYS.join(", ")}`);
    }
    if (seen.has(key)) return fail("bad_instance", `${key} is given twice`);
    seen.add(key);
    if (key === "variant") out.variant = value;
    else if (key === "label_seed") out.label_seed = value;
    else if (key === "strip_semantics") {
      const f = parseFlag(value);
      if (f === undefined) return fail("bad_instance", "strip_semantics takes 1, 0, true, or false");
      out.strip_semantics = f;
    } else if (key === "drop_labels") {
      const n = parseNumber(value);
      if (n === undefined || n > 1) return fail("bad_instance", "drop_labels takes a number from 0 to 1");
      out.drop_labels = n;
    } else {
      const n = parseNumber(value);
      if (n === undefined || n === 0) return fail("bad_instance", "delay_scale takes a number above 0");
      out.delay_scale = n;
    }
  }
  const differs = KEYS.filter((k) => {
    const was = k === "delay_scale" ? (base.delay_scale ?? 1) : base[k];
    const now = k === "delay_scale" ? (out.delay_scale ?? 1) : out[k];
    return was !== now;
  });
  return ok({ instance: out, differs });
}
