// In-memory score store, the fake twin of the file adapter.
// Follows design section 9 §5.9 (stores in memory). Shares the file adapter's key-path rules.
import { never, type z } from "zod";
import { LiveLine } from "../core/model/live-line.js";
import { assertSafeRelPath } from "../core/model/safe-path.js";
import { fail, ok, type Outcome } from "../ports/outcome.js";
import type { ScoreStore } from "../ports/scores.js";
import { FakeLogStore } from "./stores.js";

/** Score files in maps. Set `failWrites` to make every write return `write_failed`. */
export class FakeScoreStore<H, R, L = LiveLine> implements ScoreStore<H, R, L> {
  /** When true, `append` and `putRecord` fail, like a full disk. */
  failWrites = false;
  readonly #log: FakeLogStore<H, R>;
  readonly #live: FakeLogStore<L, never>;
  readonly #paths = new Set<string>();

  /** A store whose lines and records follow `schemas`. */
  constructor(schemas: { line: z.ZodType<H>; record: z.ZodType<R>; live?: z.ZodType<L> }) {
    this.#log = new FakeLogStore(schemas);
    // Why the cast: a store built with no live schema serves live lines, so the default is `LiveLine`.
    this.#live = new FakeLogStore<L, never>({ line: schemas.live ?? (LiveLine as unknown as z.ZodType<L>), record: never() });
  }

  /** Appends one live line. */
  async appendLive(path: string, line: L): Promise<Outcome<void, "write_failed">> {
    assertSafeRelPath(path);
    if (this.failWrites) return fail("write_failed", "fake write failure");
    this.#paths.add(path);
    return this.#live.append(`${path}/live`, line);
  }

  /** Reads every live line. */
  liveLines(path: string): Promise<Outcome<L[], "invalid">> {
    assertSafeRelPath(path);
    return this.#live.lines(`${path}/live`);
  }

  /** Replaces the live lines whole. */
  putLive(path: string, lines: readonly L[]): Promise<Outcome<void, "write_failed">> {
    assertSafeRelPath(path);
    if (this.failWrites) return Promise.resolve(fail("write_failed", "fake write failure"));
    this.#paths.add(path);
    this.#live.replace(`${path}/live`, lines);
    return Promise.resolve(ok(undefined));
  }

  /** Appends one history line. */
  async append(path: string, line: H): Promise<Outcome<void, "write_failed">> {
    assertSafeRelPath(path);
    if (this.failWrites) return fail("write_failed", "fake write failure");
    this.#paths.add(path);
    return this.#log.append(`${path}/history`, line);
  }

  /** Reads every history line. */
  history(path: string): Promise<Outcome<H[], "invalid">> {
    assertSafeRelPath(path);
    return this.#log.lines(`${path}/history`);
  }

  /** Replaces the record. */
  async putRecord(path: string, record: R): Promise<Outcome<void, "write_failed">> {
    assertSafeRelPath(path);
    if (this.failWrites) return fail("write_failed", "fake write failure");
    this.#paths.add(path);
    return this.#log.putRecord(`${path}/record`, record);
  }

  /** Reads the record. */
  getRecord(path: string): Promise<Outcome<R, "not_found" | "invalid">> {
    assertSafeRelPath(path);
    return this.#log.getRecord(`${path}/record`);
  }

  /** Lists the key paths of one tenant. */
  paths(tenant: string): Promise<string[]> {
    return Promise.resolve([...this.#paths].filter((p) => p.startsWith(`${tenant}/`)).sort());
  }
}
