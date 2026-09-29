// Recorder step 6 (section 6 §14.2, §14.6): `runs_on.paths`, every location a kept step saw,
// turned into stable path patterns.
import { PathPattern } from "../model/common.js";

/** True when a path segment or query value cannot be trusted to repeat next run: it holds a
 * digit, a `{input.*}`/`{secret.*}` reference, or a `[name#1]`-style mask token (section 6 §14.6). */
function isDynamic(text: string): boolean {
  return /[0-9{[]/.test(text);
}

/**
 * Turns one observed, masked location into a path pattern (section 6 §14.6): a dynamic path
 * segment becomes `*`; a query pair with a dynamic value is dropped; a constant query pair
 * stays, like `?cmd=view`.
 */
export function toPathPattern(location: string): string {
  const q = location.indexOf("?");
  const pathPart = q === -1 ? location : location.slice(0, q);
  const path =
    pathPart === "/"
      ? "/"
      : pathPart
          .split("/")
          .map((seg) => (seg === "" || !isDynamic(seg) ? seg : "*"))
          .join("/");
  if (q === -1) return path;
  const kept = location
    .slice(q + 1)
    .split("&")
    .filter((pair) => {
      const value = pair.slice(pair.indexOf("=") + 1);
      return value !== "" && !isDynamic(value);
    });
  return kept.length === 0 ? path : `${path}?${kept.join("&")}`;
}

/**
 * `runs_on.paths` (section 6 §14.6): `entry`, plus every location a kept action saw, as
 * patterns, deduplicated and in first-seen order. A pattern that fails the loader's own path
 * grammar (`PathPattern`) is dropped with a warning issue instead of breaking the candidate;
 * building the full issue list is a later task (section 6 §14.15).
 */
export function buildPaths(
  entry: string,
  locations: readonly string[],
): { paths: string[]; unmatched: string[] } {
  const seen = new Set<string>();
  const paths: string[] = [];
  const unmatched: string[] = [];
  for (const loc of [entry, ...locations]) {
    const pattern = toPathPattern(loc);
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    if (PathPattern.safeParse(pattern).success) paths.push(pattern);
    else unmatched.push(loc);
  }
  return { paths, unmatched };
}
