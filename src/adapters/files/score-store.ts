// The score store on plain files: `state/trust/scores/<key path>/{history.jsonl,record.json}`.
// Follows design section 8 §5.2 and section 9 §6.3. Record writes stage in `state/var/tmp`, then rename.
import { join } from "node:path";
import type { z } from "zod";
import { assertSafeName } from "../../core/model/safe-path.js";
import type { Outcome } from "../../ports/outcome.js";
import type { ScoreStore } from "../../ports/scores.js";
import { walkFiles } from "./fs-util.js";
import { FileLogStore } from "./other-stores.js";

/** The files that make a folder a key. */
const KEY_FILES = new Set(["history.jsonl", "live.jsonl", "record.json"]);

/** Score files on disk. One `FileLogStore` does the appends and atomic record writes. */
export class FileScoreStore<H, R> implements ScoreStore<H, R> {
  readonly #log: FileLogStore<H, R>;
  readonly #dir: string;

  /** A store in `dirs.dir`. Example: `<root>/state/trust/scores`. */
  constructor(
    schemas: { line: z.ZodType<H>; record: z.ZodType<R> },
    dirs: { dir: string; tmpDir: string },
  ) {
    this.#log = new FileLogStore(schemas, dirs);
    this.#dir = dirs.dir;
  }

  /** Appends one history line. */
  append(path: string, line: H): Promise<Outcome<void, "write_failed">> {
    return this.#log.append(`${path}/history`, line);
  }

  /** Reads every history line. */
  history(path: string): Promise<Outcome<H[], "invalid">> {
    return this.#log.lines(`${path}/history`);
  }

  /** Replaces the record atomically. */
  putRecord(path: string, record: R): Promise<Outcome<void, "write_failed">> {
    return this.#log.putRecord(`${path}/record`, record);
  }

  /** Reads the record. */
  getRecord(path: string): Promise<Outcome<R, "not_found" | "invalid">> {
    return this.#log.getRecord(`${path}/record`);
  }

  /** Lists the folders of one tenant that hold a score file. */
  async paths(tenant: string): Promise<string[]> {
    assertSafeName(tenant);
    const found = new Set<string>();
    for (const file of await walkFiles(join(this.#dir, tenant))) {
      const cut = file.lastIndexOf("/");
      if (cut > 0 && KEY_FILES.has(file.slice(cut + 1))) found.add(`${tenant}/${file.slice(0, cut)}`);
    }
    return [...found].sort();
  }
}
