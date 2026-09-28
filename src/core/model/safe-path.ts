// Checks that an ID or relative path cannot leave its store folder.
// Follows design section 9 §6.2 and §6.3 (IDs become folder names).

/** One path segment: letters, digits, and `_ . @ + -`, not starting with a dot. */
const SEGMENT = /^[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*$/;

/** True when `path` is relative, uses `/`, and has no empty, `.`, or `..` segment. Example: `tenant/keystone`. */
export function isSafeRelPath(path: string): boolean {
  return path.split("/").every((s) => SEGMENT.test(s));
}

/** Throws on an unsafe path. Why a throw: callers must validate IDs first, so this is a bug. */
export function assertSafeRelPath(path: string): void {
  if (!isSafeRelPath(path)) throw new Error(`unsafe store path: ${JSON.stringify(path)}`);
}

/** Throws unless `name` is one safe segment, such as a tenant or run ID. */
export function assertSafeName(name: string): void {
  if (!SEGMENT.test(name)) throw new Error(`unsafe store path: ${JSON.stringify(name)}`);
}
