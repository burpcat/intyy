// In-memory fake twin of the file tree port. Same rules as the file adapter.
// Follows design section 9 §6.6 and §5.9. `seed` puts a file in without a write, for test setup.
import { assertSafeRelPath } from "../core/model/safe-path.js";
import { fail, ok, type Outcome } from "../ports/outcome.js";
import type { FileTree, TreeFile } from "../ports/tree.js";

/** A {@link FileTree} held in a map. */
export class FakeFileTree implements FileTree {
  readonly #files = new Map<string, Uint8Array>();
  /** Paths whose write fails with `write_failed`, to test a full disk. */
  readonly failWrites = new Set<string>();

  /** Puts a file in directly. Text is stored as UTF-8. */
  seed(path: string, data: string | Uint8Array): void {
    assertSafeRelPath(path);
    this.#files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
  }

  /** Every path now held, sorted. For assertions. */
  paths(): string[] {
    return [...this.#files.keys()].sort();
  }

  /** Lists files under `prefix`. */
  list(prefix: string): Promise<TreeFile[]> {
    if (prefix !== "") assertSafeRelPath(prefix.replace(/\/$/, ""));
    const base = prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`;
    return Promise.resolve(
      this.paths()
        .filter((p) => p.startsWith(base))
        .map((p) => ({ path: p, bytes: this.#files.get(p)?.byteLength ?? 0 })),
    );
  }

  /** Reads one file. */
  read(path: string): Promise<Outcome<Uint8Array, "not_found">> {
    assertSafeRelPath(path);
    const bytes = this.#files.get(path);
    return Promise.resolve(bytes === undefined ? fail("not_found", path) : ok(bytes));
  }

  /** Writes one file. */
  write(path: string, bytes: Uint8Array): Promise<Outcome<void, "write_failed">> {
    assertSafeRelPath(path);
    if (this.failWrites.has(path)) return Promise.resolve(fail("write_failed", path));
    this.#files.set(path, new Uint8Array(bytes));
    return Promise.resolve(ok(undefined));
  }
}
