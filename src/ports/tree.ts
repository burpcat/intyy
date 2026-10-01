// The file tree port: read, list, and write whole files under one root folder.
// Follows design section 9 §6.6 (publishing evidence). Core has no `node:fs`, so evidence publish
// and verify reach `state/evidence/`, `library/artifacts/`, and the published `evidence/` through it.
import type { Outcome } from "./outcome.js";

/** One file in a listing: its path under the tree's root (with `/`), and its size. */
export type TreeFile = { path: string; bytes: number };

/**
 * A folder of files. Paths are relative to the root, use `/`, and never leave it: every adapter
 * rejects an unsafe path with a throw (a bug), like the store adapters do.
 */
export interface FileTree {
  /** Lists every file under `prefix` (use `""` for all), sorted by path. A missing folder lists nothing. */
  list(prefix: string, signal?: AbortSignal): Promise<TreeFile[]>;
  /** Reads one file as bytes. */
  read(path: string, signal?: AbortSignal): Promise<Outcome<Uint8Array, "not_found">>;
  /** Writes one file atomically, making folders as needed. Replaces a file already there. */
  write(
    path: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Outcome<void, "write_failed">>;
}
