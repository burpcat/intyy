// The path matcher: cleans a page address, then matches it against path patterns.
// Follows design section 4 §6.3 (rules, examples, normalizing) and §3.6 (`allowlist.path_malformed`).
import { fail, ok, type Outcome } from "../../../ports/outcome.js";

/** A parsed path pattern, ready to match. Example text: `/members/*`, `/Main.do?cmd=view*`. */
export type PathMatcher = {
  readonly text: string;
  readonly path: string;
  readonly query: readonly { name: string; value: string }[];
};

/** A cleaned page address. `path` has no `//`, `.`, `..`, `;` parameters, or fragment. */
export type NormalPath = {
  readonly path: string;
  readonly query: readonly [name: string, value: string][];
};

/** Characters a pattern never holds. A clean path cannot contain them in this form. */
const PATTERN_BANNED = /[\s#\\%;]/;

/** One pattern part: literal text and `*`. A `**` is two stars with nothing between. */
function badPart(part: string): string | null {
  if (part.includes("**")) return "** is not allowed; * already covers one or more characters";
  return null;
}

/**
 * Parses a path pattern (section 4 §6.3). `invalid` when the pattern could never match a clean
 * path, such as `/a//b` or `/a/../b`, so a typo cannot pass the loader and then allow nothing.
 */
export function parsePattern(text: string): Outcome<PathMatcher, "invalid"> {
  if (!text.startsWith("/")) return fail("invalid", "a path pattern starts with /");
  if (PATTERN_BANNED.test(text)) {
    return fail("invalid", "a path pattern holds no space, #, \\, %, or ;");
  }
  const q = text.indexOf("?");
  const path = q === -1 ? text : text.slice(0, q);
  const segments = path.split("/").slice(1);
  for (const [i, seg] of segments.entries()) {
    const last = i === segments.length - 1;
    if (seg === "" && !last) return fail("invalid", "a path pattern has no //");
    if (seg === "." || seg === "..") return fail("invalid", "a path pattern has no . or ..");
    const bad = badPart(seg);
    if (bad !== null) return fail("invalid", bad);
  }
  const query: { name: string; value: string }[] = [];
  if (q !== -1) {
    for (const pair of text.slice(q + 1).split("&")) {
      const eq = pair.indexOf("=");
      const name = eq === -1 ? "" : pair.slice(0, eq);
      const value = eq === -1 ? "" : pair.slice(eq + 1);
      if (name === "" || value === "" || name.includes("*") || value.includes("?")) {
        return fail("invalid", "each query part is name=value, like cmd=view*");
      }
      const bad = badPart(value);
      if (bad !== null) return fail("invalid", bad);
      query.push({ name, value });
    }
  }
  return ok({ text, path, query });
}

/** Matches text against a pattern part. `*` is one or more characters, never `/`. */
function matchPart(pattern: string, value: string, foldCase: boolean): boolean {
  const source = pattern
    .split("*")
    .map((lit) => lit.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]+");
  return new RegExp(`^${source}$`, foldCase ? "i" : "").test(value);
}

/** Rejects `%2F`, `%5C`, and `%00`, also when encoded twice, like `%252F` (section 4 §6.3 step 2). */
const ENCODED_TRICK = /%(25)*(2f|5c|00)/i;

/**
 * Cleans a page address before any match (section 4 §6.3, "Normalizing before matching").
 * `raw` is the path, query, and fragment, like `/members/100107;jsessionid=x?tab=2#top`.
 * `malformed` maps to rule `allowlist.path_malformed`.
 */
export function normalizePath(
  raw: string,
  caseSensitive: boolean,
): Outcome<NormalPath, "malformed"> {
  // Why: split off the fragment and query before decoding, so `%23` and `%3F` stay path text.
  const hash = raw.indexOf("#");
  const noFragment = hash === -1 ? raw : raw.slice(0, hash);
  const q = noFragment.indexOf("?");
  const rawPath = q === -1 ? noFragment : noFragment.slice(0, q);
  const rawQuery = q === -1 ? "" : noFragment.slice(q + 1);

  if (ENCODED_TRICK.test(rawPath))
    return fail("malformed", "encoded slash, backslash, or null byte");
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return fail("malformed", "broken percent code");
  }
  if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) {
    return fail("malformed", "backslash, null byte, or no leading /");
  }

  const out: string[] = [];
  const segments = decoded.split("/").slice(1);
  let trailing = false;
  for (const seg of segments) {
    // Why: strip `;` parameters before resolving `..`. Old Java servers read `..;x` as `..`,
    // so resolving first would let `/a/..;x/admin` hide a jump to `/admin`.
    const clean = seg.split(";")[0] ?? "";
    trailing = clean === "" || clean === "." || clean === "..";
    if (clean === "..") out.pop();
    else if (clean !== "" && clean !== ".") out.push(clean);
  }
  let path = `/${out.join("/")}${trailing && out.length > 0 ? "/" : ""}`;
  if (!caseSensitive) path = path.toLowerCase();

  const query = [...new URLSearchParams(rawQuery)];
  return ok({ path, query });
}

/**
 * True when a clean path matches the pattern (section 4 §6.3, "Rules").
 * A pattern without `?` ignores the query. With `?`, each listed parameter must be present,
 * and every copy of it must match. Other parameters are ignored.
 */
export function matchPath(p: PathMatcher, n: NormalPath, caseSensitive: boolean): boolean {
  if (!matchPart(p.path, n.path, !caseSensitive)) return false;
  return p.query.every(({ name, value }) => {
    const copies = n.query.filter(([k]) => k === name);
    // Why: servers differ on which copy of a repeated parameter wins. Every copy must match.
    return copies.length > 0 && copies.every(([, v]) => matchPart(value, v, false));
  });
}

/** True when the clean path matches any pattern in the list. */
export function matchesAny(
  patterns: readonly PathMatcher[],
  n: NormalPath,
  caseSensitive: boolean,
): boolean {
  return patterns.some((p) => matchPath(p, n, caseSensitive));
}
