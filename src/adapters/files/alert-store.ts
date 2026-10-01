// The alert store on plain files: `state/trust/alerts/<id>.json`, staged in `state/var/tmp`.
// Follows design section 8 §13.1 and section 9 §6.3.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { assertSafeName } from "../../core/model/safe-path.js";
import type { AlertStore } from "../../ports/alerts.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import { hasCode, prettyJson, readJson, writeAtomic } from "./fs-util.js";

/** Alert files on disk. */
export class FileAlertStore<A> implements AlertStore<A> {
  readonly #schema: z.ZodType<A>;
  readonly #dir: string;
  readonly #tmpDir: string;

  /** A store in `dirs.dir`. Example: `<root>/state/trust/alerts`. */
  constructor(schema: z.ZodType<A>, dirs: { dir: string; tmpDir: string }) {
    this.#schema = schema;
    this.#dir = dirs.dir;
    this.#tmpDir = dirs.tmpDir;
  }

  /** Writes one alert atomically. */
  async put(id: string, alert: A): Promise<Outcome<void, "write_failed">> {
    assertSafeName(id);
    try {
      await writeAtomic(this.#tmpDir, join(this.#dir, `${id}.json`), prettyJson(alert));
      return ok(undefined);
    } catch (e) {
      return fail("write_failed", e instanceof Error ? e.message : String(e));
    }
  }

  /** Reads one alert. */
  async get(id: string): Promise<Outcome<A, "not_found" | "invalid">> {
    assertSafeName(id);
    const read = await readJson(join(this.#dir, `${id}.json`));
    if (read.kind === "missing") return fail("not_found", id);
    if (read.kind === "bad") return fail("invalid", read.detail);
    const parsed = this.#schema.safeParse(read.value);
    return parsed.success ? ok(parsed.data) : fail("invalid", `${id}.json: ${parsed.error.message}`);
  }

  /** Reads every alert, sorted by ID. */
  async list(): Promise<Outcome<A[], "invalid">> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch (e) {
      if (hasCode(e, "ENOENT")) return ok([]);
      throw e;
    }
    const out: A[] = [];
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
      const one = await this.get(name.slice(0, -".json".length));
      if (!one.ok) return fail("invalid", one.detail ?? one.failure);
      out.push(one.value);
    }
    return ok(out);
  }
}
