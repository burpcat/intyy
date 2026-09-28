// File helpers for the store adapters: atomic writes, line appends, and safe reads.
// Follows design section 9 §6.3 (`state/var/tmp` stages atomic writes) and section 3 §6.1, §7.3.
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/** True when `e` is a Node error with this `code`. Example: `ENOENT`. */
export function hasCode(e: unknown, code: string): boolean {
  return e instanceof Error && "code" in e && e.code === code;
}

/** The result of reading a JSON file. */
export type JsonRead =
  { kind: "ok"; value: unknown } | { kind: "missing" } | { kind: "bad"; detail: string };

/** Reads and parses one JSON file. A missing file is `missing`; unparsable text is `bad`. */
export async function readJson(path: string): Promise<JsonRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (hasCode(e, "ENOENT")) return { kind: "missing" };
    throw e;
  }
  try {
    return { kind: "ok", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "bad", detail: `${path} is not valid JSON` };
  }
}

/** Reads a JSONL file. A missing file is `null`. A bad line is reported with its number. */
export async function readJsonLines(
  path: string,
): Promise<{ ok: true; lines: unknown[] } | { ok: false; detail: string } | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (hasCode(e, "ENOENT")) return null;
    throw e;
  }
  const lines: unknown[] = [];
  const raw = text.split("\n");
  for (const [i, line] of raw.entries()) {
    if (line.trim() === "") continue;
    try {
      lines.push(JSON.parse(line) as unknown);
    } catch {
      return { ok: false, detail: `${path} line ${String(i + 1)} is not valid JSON` };
    }
  }
  return { ok: true, lines };
}

/** Pretty JSON for files humans review in git: two spaces and a final newline. */
export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Writes a file atomically: a temp file in `tmpDir`, flushed, then renamed over `path`.
 * A crash never leaves half a file (section 3 §7.3).
 */
export async function writeAtomic(
  tmpDir: string,
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  await mkdir(tmpDir, { recursive: true });
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(tmpDir, `${String(process.pid)}-${randomUUID()}.tmp`);
  const fh = await open(tmp, "wx");
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}

/** Appends one line in a single write. `durable` forces it to disk before returning. */
export async function appendLine(path: string, line: string, durable = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const fh = await open(path, "a");
  try {
    await fh.write(`${line}\n`);
    if (durable) await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Lists every file under `dir`, as paths relative to it with `/`. A missing folder lists nothing. */
export async function walkFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) =>
        join(e.parentPath, e.name)
          .slice(dir.length + 1)
          .split("\\")
          .join("/"),
      )
      .sort();
  } catch (e) {
    if (hasCode(e, "ENOENT")) return [];
    throw e;
  }
}
