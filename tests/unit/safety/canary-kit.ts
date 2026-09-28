// Test helpers for canary scans: read every file under a folder, and make temporary data roots.
// The scanner lives in core and reads no files; tests hand it the bytes. Section 4 §14.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ScanFile } from "../../../src/core/safety/canary/scan.js";

/** Every file under `root`, with its path relative to `root`. */
export async function readTree(root: string): Promise<ScanFile[]> {
  const out: ScanFile[] = [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = join(e.parentPath, e.name);
    out.push({ path: relative(root, full), bytes: await readFile(full) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** A temporary folder and a function that removes it. */
export async function tempRoot(
  prefix: string,
): Promise<{ root: string; remove: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}
