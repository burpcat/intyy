// The candidate, log, and evidence stores on plain files.
// Follows design section 9 §5.8, §6.2, §6.3, and section 3 §6.1, §7.1, §7.3.
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { sha256Hex } from "../../core/model/canonical.js";
import { assertSafeName, assertSafeRelPath } from "../../core/model/safe-path.js";
import { findLine, sealHash } from "../../core/model/sealing.js";
import { IndexLine } from "../../core/model/store-index.js";
import type { Clock } from "../../ports/clock.js";
import type { Masked } from "../../ports/masked.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type {
  AppendOptions,
  CandidateStore,
  DocId,
  EvidenceStore,
  LogStore,
  Rev,
  RunFolder,
} from "../../ports/stores.js";
import {
  appendLine,
  hasCode,
  prettyJson,
  readJson,
  readJsonLines,
  walkFiles,
  writeAtomic,
} from "./fs-util.js";

/** Turns an unexpected write error into `write_failed`, with the error text as detail. */
async function guardWrite(write: () => Promise<void>): Promise<Outcome<void, "write_failed">> {
  try {
    await write();
    return ok(undefined);
  } catch (e) {
    return fail("write_failed", e instanceof Error ? e.message : String(e));
  }
}

/** Parses every line with `schema`. The first bad line fails the read. */
function parseLines<L>(
  lines: unknown[],
  schema: z.ZodType<L>,
  where: string,
): Outcome<L[], "invalid"> {
  const out: L[] = [];
  for (const [i, line] of lines.entries()) {
    const parsed = schema.safeParse(line);
    if (!parsed.success)
      return fail("invalid", `${where} line ${String(i + 1)}: ${parsed.error.message}`);
    out.push(parsed.data);
  }
  return ok(out);
}

/** Schemas for a candidate folder's files and its decision lines. */
export type CandidateSchemas<F extends Record<string, unknown>, D> = {
  files: { [K in keyof F]: z.ZodType<F[K]> };
  decision: z.ZodType<D>;
};

/** Where a file candidate store keeps its candidates, its sealed artifacts, and its temp files. */
export type CandidateStoreDirs = {
  /** The candidates folder. Example: `<root>/library/candidates`. */
  dir: string;
  /** The sealed artifacts folder. Example: `<root>/library/artifacts`. */
  artifactsDir: string;
  /** Staging for atomic writes: `<root>/state/var/tmp`. */
  tmpDir: string;
};

const DECISIONS = "decisions.jsonl";

/** A candidate id's `<app>/<capability>` prefix, which sealing writes under (section 9 §6.2). */
function artifactIdOf(id: DocId): string {
  const cut = id.indexOf("/", id.indexOf("/") + 1);
  if (cut < 0) throw new Error(`candidate id has no app/capability: ${id}`);
  return id.slice(0, cut);
}

/** A folder per artifact candidate, on files (section 9 §6.2). */
export class FileCandidateStore<F extends Record<string, unknown>, D> implements CandidateStore<
  F,
  D
> {
  readonly #schemas: CandidateSchemas<F, D>;
  readonly #dir: string;
  readonly #artifactsDir: string;
  readonly #tmpDir: string;
  readonly #clock: Clock;

  /** A store in `dirs.dir`, sealing into `dirs.artifactsDir`. */
  constructor(schemas: CandidateSchemas<F, D>, dirs: CandidateStoreDirs, clock: Clock) {
    this.#schemas = schemas;
    this.#dir = dirs.dir;
    this.#artifactsDir = dirs.artifactsDir;
    this.#tmpDir = dirs.tmpDir;
    this.#clock = clock;
  }

  /** Writes one file atomically. */
  putFile<K extends keyof F & string>(
    id: DocId,
    name: K,
    data: F[K],
  ): Promise<Outcome<void, "write_failed">> {
    assertSafeRelPath(id);
    return guardWrite(() => writeAtomic(this.#tmpDir, join(this.#dir, id, name), prettyJson(data)));
  }

  /** Reads one file. */
  async getFile<K extends keyof F & string>(
    id: DocId,
    name: K,
  ): Promise<Outcome<F[K], "not_found" | "invalid">> {
    assertSafeRelPath(id);
    const read = await readJson(join(this.#dir, id, name));
    if (read.kind === "missing") return fail("not_found", `${id}/${name}`);
    if (read.kind === "bad") return fail("invalid", read.detail);
    const parsed = this.#schemas.files[name].safeParse(read.value);
    return parsed.success
      ? ok(parsed.data)
      : fail("invalid", `${id}/${name}: ${parsed.error.message}`);
  }

  /** Appends one decision line. */
  appendDecision(id: DocId, decision: D): Promise<Outcome<void, "write_failed">> {
    assertSafeRelPath(id);
    return guardWrite(() => appendLine(join(this.#dir, id, DECISIONS), JSON.stringify(decision)));
  }

  /** Reads every decision. */
  async decisions(id: DocId): Promise<Outcome<D[], "invalid">> {
    assertSafeRelPath(id);
    const read = await readJsonLines(join(this.#dir, id, DECISIONS));
    if (read === null) return ok([]);
    if (!read.ok) return fail("invalid", read.detail);
    return parseLines(read.lines, this.#schemas.decision, `${id}/${DECISIONS}`);
  }

  /** Lists candidate IDs: folders that hold a known file or a decision log. */
  async list(): Promise<DocId[]> {
    const names = new Set([...Object.keys(this.#schemas.files), DECISIONS]);
    const ids = new Set<DocId>();
    for (const file of await walkFiles(this.#dir)) {
      const cut = file.lastIndexOf("/");
      if (cut > 0 && names.has(file.slice(cut + 1))) ids.add(file.slice(0, cut));
    }
    return [...ids].sort();
  }

  /** Seals a candidate as one artifact version. Refuses a version already sealed. */
  async seal(
    id: DocId,
    version: Rev,
    staff: string,
    artifact: unknown,
    crops: Record<string, Uint8Array>,
  ): Promise<Outcome<{ hash: string }, "conflict" | "write_failed" | "invalid">> {
    assertSafeRelPath(id);
    assertSafeRelPath(version);
    const artifactId = artifactIdOf(id);
    const index = await this.#artifactIndex();
    if (!index.ok) return index;
    if (findLine(index.value, "sealed", artifactId, version))
      return fail("conflict", `${artifactId} ${version} is already sealed`);
    const hash = sealHash(artifact);
    const base = join(this.#artifactsDir, artifactId, version);
    const written = await guardWrite(async () => {
      await writeAtomic(this.#tmpDir, join(base, "artifact.json"), prettyJson(artifact));
      for (const [targetId, bytes] of Object.entries(crops)) {
        assertSafeName(targetId);
        await writeAtomic(this.#tmpDir, join(base, "crops", `${targetId}.png`), bytes);
      }
    });
    if (!written.ok) return written;
    const line: IndexLine = {
      event: "sealed",
      kind: "artifact",
      id: artifactId,
      rev: version,
      path: `${artifactId}/${version}/artifact.json`,
      hash,
      by: staff,
      at: this.#clock.now().toISOString(),
    };
    await appendLine(join(this.#artifactsDir, "index.jsonl"), JSON.stringify(line), true);
    return ok({ hash });
  }

  /** The artifacts store's `sealed` index lines. */
  async #artifactIndex(): Promise<Outcome<IndexLine[], "invalid">> {
    const read = await readJsonLines(join(this.#artifactsDir, "index.jsonl"));
    if (read === null) return ok([]);
    if (!read.ok) return fail("invalid", read.detail);
    const lines: IndexLine[] = [];
    for (const raw of read.lines) {
      const parsed = IndexLine.safeParse(raw);
      if (!parsed.success) return fail("invalid", `index.jsonl: ${parsed.error.message}`);
      lines.push(parsed.data);
    }
    return ok(lines);
  }
}

/** Append-only logs and rebuilt records, on files. Key `a/b/history` is `a/b/history.jsonl` or `.json`. */
export class FileLogStore<L, R> implements LogStore<L, R> {
  readonly #schemas: { line: z.ZodType<L>; record: z.ZodType<R> };
  readonly #dir: string;
  readonly #tmpDir: string;

  /** A store in `dir`. Example: `<root>/state/trust/scores`. */
  constructor(
    schemas: { line: z.ZodType<L>; record: z.ZodType<R> },
    dirs: { dir: string; tmpDir: string },
  ) {
    this.#schemas = schemas;
    this.#dir = dirs.dir;
    this.#tmpDir = dirs.tmpDir;
  }

  /** Appends one line. */
  append(key: string, line: L): Promise<Outcome<void, "write_failed">> {
    assertSafeRelPath(key);
    return guardWrite(() => appendLine(join(this.#dir, `${key}.jsonl`), JSON.stringify(line)));
  }

  /** Reads every line. */
  async lines(key: string): Promise<Outcome<L[], "invalid">> {
    assertSafeRelPath(key);
    const read = await readJsonLines(join(this.#dir, `${key}.jsonl`));
    if (read === null) return ok([]);
    if (!read.ok) return fail("invalid", read.detail);
    return parseLines(read.lines, this.#schemas.line, `${key}.jsonl`);
  }

  /** Replaces the record atomically. */
  putRecord(key: string, record: R): Promise<Outcome<void, "write_failed">> {
    assertSafeRelPath(key);
    return guardWrite(() =>
      writeAtomic(this.#tmpDir, join(this.#dir, `${key}.json`), prettyJson(record)),
    );
  }

  /** Reads the record. */
  async getRecord(key: string): Promise<Outcome<R, "not_found" | "invalid">> {
    assertSafeRelPath(key);
    const read = await readJson(join(this.#dir, `${key}.json`));
    if (read.kind === "missing") return fail("not_found", key);
    if (read.kind === "bad") return fail("invalid", read.detail);
    const parsed = this.#schemas.record.safeParse(read.value);
    return parsed.success
      ? ok(parsed.data)
      : fail("invalid", `${key}.json: ${parsed.error.message}`);
  }
}

/** One run folder on files (section 3 §7.1). */
class FileRunFolder implements RunFolder {
  readonly runId: string;
  readonly #dir: string;
  readonly #tmpDir: string;

  constructor(runId: string, dir: string, tmpDir: string) {
    this.runId = runId;
    this.#dir = dir;
    this.#tmpDir = tmpDir;
  }

  /** Appends one line. `durable` forces it to disk first: the write-ahead rule (section 3 §6.6). */
  appendEvent(line: Masked<unknown>, opts?: AppendOptions): Promise<Outcome<void, "write_failed">> {
    const durable = opts?.durable === true;
    return guardWrite(() =>
      appendLine(join(this.#dir, "events.jsonl"), JSON.stringify(line), durable),
    );
  }

  async writeFile(
    path: string,
    bytes: Masked<string> | Masked<Uint8Array>,
  ): Promise<Outcome<{ sha256: string; bytes: number }, "write_failed">> {
    assertSafeRelPath(path);
    const written = await guardWrite(() => writeAtomic(this.#tmpDir, join(this.#dir, path), bytes));
    if (!written.ok) return written;
    const size = typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength;
    return ok({ sha256: sha256Hex(bytes), bytes: size });
  }

  writeRunJson(run: Masked<unknown>): Promise<Outcome<void, "write_failed">> {
    return guardWrite(() =>
      writeAtomic(this.#tmpDir, join(this.#dir, "run.json"), prettyJson(run)),
    );
  }
}

/** Run folders and tenant indexes under `state/evidence/` (section 9 §6.3). */
export class FileEvidenceStore implements EvidenceStore {
  readonly #root: string;
  readonly #tmpDir: string;

  /** A store in `root`: `<root>/state/evidence`. */
  constructor(dirs: { root: string; tmpDir: string }) {
    this.#root = dirs.root;
    this.#tmpDir = dirs.tmpDir;
  }

  /** Creates a run folder. The final `mkdir` is not recursive, so a second create is a conflict. */
  async createRun(
    tenant: string,
    runId: string,
  ): Promise<Outcome<RunFolder, "conflict" | "write_failed">> {
    const dir = this.#runDir(tenant, runId);
    try {
      await mkdir(join(this.#root, tenant, "runs"), { recursive: true });
      await mkdir(dir);
    } catch (e) {
      if (hasCode(e, "EEXIST")) return fail("conflict", `${runId} exists`);
      return fail("write_failed", e instanceof Error ? e.message : String(e));
    }
    return ok(new FileRunFolder(runId, dir, this.#tmpDir));
  }

  /** Opens an existing run folder. */
  async openRun(tenant: string, runId: string): Promise<Outcome<RunFolder, "not_found">> {
    const dir = this.#runDir(tenant, runId);
    try {
      if ((await stat(dir)).isDirectory()) return ok(new FileRunFolder(runId, dir, this.#tmpDir));
    } catch (e) {
      if (!hasCode(e, "ENOENT")) throw e;
    }
    return fail("not_found", runId);
  }

  /** Reads `run.json`. */
  async readRunJson(
    tenant: string,
    runId: string,
  ): Promise<Outcome<unknown, "not_found" | "invalid">> {
    const read = await readJson(join(this.#runDir(tenant, runId), "run.json"));
    if (read.kind === "missing") return fail("not_found", `${runId}/run.json`);
    if (read.kind === "bad") return fail("invalid", read.detail);
    return ok(read.value);
  }

  /** Reads the run log. */
  async events(
    tenant: string,
    runId: string,
  ): Promise<Outcome<unknown[], "not_found" | "invalid">> {
    const opened = await this.openRun(tenant, runId);
    if (!opened.ok) return opened;
    const read = await readJsonLines(join(this.#runDir(tenant, runId), "events.jsonl"));
    if (read === null) return ok([]);
    return read.ok ? ok(read.lines) : fail("invalid", read.detail);
  }

  /** Appends to the tenant index. */
  appendIndex(tenant: string, line: Masked<unknown>): Promise<Outcome<void, "write_failed">> {
    assertSafeName(tenant);
    return guardWrite(() =>
      appendLine(join(this.#root, tenant, "index.jsonl"), JSON.stringify(line)),
    );
  }

  /** Reads the tenant index. */
  async index(tenant: string): Promise<Outcome<unknown[], "invalid">> {
    assertSafeName(tenant);
    const read = await readJsonLines(join(this.#root, tenant, "index.jsonl"));
    if (read === null) return ok([]);
    return read.ok ? ok(read.lines) : fail("invalid", read.detail);
  }

  /** Lists run IDs, sorted. */
  async listRuns(tenant: string): Promise<string[]> {
    assertSafeName(tenant);
    try {
      return (await readdir(join(this.#root, tenant, "runs"))).sort();
    } catch (e) {
      if (hasCode(e, "ENOENT")) return [];
      throw e;
    }
  }

  #runDir(tenant: string, runId: string): string {
    assertSafeName(tenant);
    assertSafeName(runId);
    return join(this.#root, tenant, "runs", runId);
  }
}
