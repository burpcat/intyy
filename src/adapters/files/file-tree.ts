// The file tree port on a real folder.
// Follows design section 9 §6.6 and §6.3 (`state/var/tmp` stages atomic writes).
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeRelPath } from "../../core/model/safe-path.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { FileTree, TreeFile } from "../../ports/tree.js";
import { hasCode, walkFiles, writeAtomic } from "./fs-util.js";

/** A {@link FileTree} rooted at `root`. Writes stage in `tmpDir`. */
export class FsFileTree implements FileTree {
  readonly #root: string;
  readonly #tmpDir: string;

  /** Example: `new FsFileTree("<root>/state/evidence", "<root>/state/var/tmp")`. */
  constructor(root: string, tmpDir: string) {
    this.#root = root;
    this.#tmpDir = tmpDir;
  }

  /** Lists every file under `prefix`, with sizes. */
  async list(prefix: string): Promise<TreeFile[]> {
    if (prefix !== "") assertSafeRelPath(prefix.replace(/\/$/, ""));
    const base = prefix === "" ? "" : prefix.endsWith("/") ? prefix : `${prefix}/`;
    // Why no trailing slash on `dir`: `walkFiles` cuts `dir.length + 1` characters to drop the
    // separator, and `join` keeps a trailing `/`.
    const dir = join(this.#root, base.replace(/\/$/, ""));
    const out: TreeFile[] = [];
    for (const rel of await walkFiles(dir)) {
      out.push({ path: `${base}${rel}`, bytes: (await stat(join(dir, rel))).size });
    }
    return out;
  }

  /** Reads one file. */
  async read(path: string): Promise<Outcome<Uint8Array, "not_found">> {
    assertSafeRelPath(path);
    try {
      return ok(new Uint8Array(await readFile(join(this.#root, path))));
    } catch (e) {
      if (hasCode(e, "ENOENT")) return fail("not_found", path);
      throw e;
    }
  }

  /** Writes one file atomically. */
  async write(path: string, bytes: Uint8Array): Promise<Outcome<void, "write_failed">> {
    assertSafeRelPath(path);
    try {
      await writeAtomic(this.#tmpDir, join(this.#root, path), bytes);
      return ok(undefined);
    } catch (e) {
      return fail("write_failed", e instanceof Error ? e.message : String(e));
    }
  }
}
