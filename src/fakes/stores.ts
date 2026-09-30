// In-memory fake twins of the four store shapes. Same rules as the file adapters.
// Follows design section 9 §5.8 and §5.9. The contract suites prove both behave the same.
import type { z } from "zod";
import { sha256Hex } from "../core/model/canonical.js";
import { assertSafeName, assertSafeRelPath } from "../core/model/safe-path.js";
import {
  checkApprove,
  checkCandidate,
  checkSealed,
  findLine,
  sealHash,
  type DocKind,
} from "../core/model/sealing.js";
import type { IndexLine } from "../core/model/store-index.js";
import type { Clock } from "../ports/clock.js";
import type { Masked } from "../ports/masked.js";
import { fail, ok, type Outcome } from "../ports/outcome.js";
import type {
  Candidate,
  CandidateStore,
  DocFilter,
  DocId,
  DocSummary,
  DocumentStore,
  EvidenceStore,
  LogStore,
  Rev,
  RunFolder,
  Sealed,
} from "../ports/stores.js";

/** Copies a value the way a file round trip would. */
function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** Joins Zod issues into one line of text. */
function issues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

/** In-memory document store. `tamper` and `corruptCandidate` stand in for hand edits. */
export class FakeDocumentStore<T> implements DocumentStore<T> {
  readonly #kind: DocKind<T>;
  readonly #clock: Clock;
  readonly #candidates = new Map<DocId, unknown>();
  readonly #sealed = new Map<string, unknown>();
  readonly #index: IndexLine[] = [];

  /** A store for one record kind. */
  constructor(kind: DocKind<T>, clock: Clock) {
    this.#kind = kind;
    this.#clock = clock;
  }

  /** Reads a sealed revision and checks its hash. */
  get(id: DocId, rev: Rev): Promise<Outcome<Sealed<T>, "not_found" | "hash_mismatch" | "invalid">> {
    assertSafeRelPath(id);
    return Promise.resolve(this.#read(id, rev));
  }

  /** Reads the open candidate. */
  getCandidate(id: DocId): Promise<Outcome<Candidate<T>, "not_found" | "invalid">> {
    assertSafeRelPath(id);
    return Promise.resolve(this.#candidate(id));
  }

  /** Lists sealed revisions in index order, then candidates by ID. */
  list(filter: DocFilter): Promise<DocSummary[]> {
    const out: DocSummary[] = [];
    for (const line of this.#index) {
      if (line.event !== "sealed" || (filter.id !== undefined && line.id !== filter.id)) continue;
      const approved = findLine(this.#index, "approved", line.id, line.rev) !== undefined;
      out.push({ id: line.id, rev: line.rev, state: approved ? "approved" : "sealed" });
    }
    for (const id of [...this.#candidates.keys()].sort()) {
      if (filter.id !== undefined && id !== filter.id) continue;
      const c = this.#candidate(id);
      if (c.ok) out.push({ id, rev: c.value.rev, state: "candidate" });
    }
    return Promise.resolve(out);
  }

  /** Writes or replaces the candidate. */
  putCandidate(id: DocId, doc: T): Promise<Outcome<void, "invalid" | "conflict">> {
    assertSafeRelPath(id);
    const checked = checkCandidate(this.#kind, id, doc);
    if (!checked.ok) return Promise.resolve(checked);
    const rev = this.#kind.revOf(checked.value);
    if (findLine(this.#index, "sealed", id, rev))
      return Promise.resolve(fail("conflict", `${id} ${rev} is already sealed`));
    this.#candidates.set(id, roundTrip(doc));
    return Promise.resolve(ok(undefined));
  }

  /** Freezes the candidate and writes the index line. */
  seal(id: DocId, staff: string): Promise<Outcome<{ rev: Rev; hash: string }, "invalid" | "rule">> {
    assertSafeRelPath(id);
    const c = this.#candidate(id);
    if (!c.ok)
      return Promise.resolve(
        fail("invalid", c.failure === "not_found" ? `no candidate for ${id}` : (c.detail ?? "")),
      );
    const raw = this.#candidates.get(id);
    const hash = sealHash(raw);
    this.#sealed.set(`${id}@${c.value.rev}`, raw);
    this.#index.push(this.#line("sealed", id, c.value.rev, hash, staff));
    this.#candidates.delete(id);
    return Promise.resolve(ok({ rev: c.value.rev, hash }));
  }

  /** Stamps a sealed revision once. Never by its sealer. */
  approve(
    id: DocId,
    rev: Rev,
    staff: string,
  ): Promise<Outcome<void, "rule" | "not_found" | "hash_mismatch" | "invalid">> {
    assertSafeRelPath(id);
    const read = this.#read(id, rev);
    if (!read.ok) return Promise.resolve(read);
    const rule = checkApprove(read.value.sealedBy, staff, read.value.approved);
    if (!rule.ok) return Promise.resolve(rule);
    const line = this.#line("approved", id, rev, read.value.hash, staff);
    const raw = this.#sealed.get(`${id}@${rev}`) as Record<string, unknown>;
    this.#sealed.set(`${id}@${rev}`, { ...raw, approved: { by: line.by, at: line.at } });
    this.#index.push(line);
    return Promise.resolve(ok(undefined));
  }

  /** Test hook: changes a sealed revision in place, like a hand edit. */
  tamper(id: DocId, rev: Rev, change: (d: Record<string, unknown>) => void): void {
    const copy = roundTrip(this.#sealed.get(`${id}@${rev}`)) as Record<string, unknown>;
    change(copy);
    this.#sealed.set(`${id}@${rev}`, copy);
  }

  /** Test hook: replaces the open candidate's content. */
  corruptCandidate(id: DocId, content: unknown): void {
    this.#candidates.set(id, content);
  }

  #candidate(id: DocId): Outcome<Candidate<T>, "not_found" | "invalid"> {
    if (!this.#candidates.has(id)) return fail("not_found", `no candidate for ${id}`);
    const checked = checkCandidate(this.#kind, id, this.#candidates.get(id));
    if (!checked.ok) return checked;
    return ok({ id, rev: this.#kind.revOf(checked.value), doc: checked.value });
  }

  #read(id: DocId, rev: Rev): Outcome<Sealed<T>, "not_found" | "hash_mismatch" | "invalid"> {
    const line = findLine(this.#index, "sealed", id, rev);
    const raw = this.#sealed.get(`${id}@${rev}`);
    if (!line || raw === undefined) return fail("not_found", `${id} ${rev} is not sealed`);
    const check = checkSealed(raw, line, findLine(this.#index, "approved", id, rev));
    if (!check.ok) return check;
    const parsed = this.#kind.parse(raw);
    if (!parsed.success) return fail("invalid", issues(parsed.error));
    return ok({
      id,
      rev,
      hash: line.hash,
      sealedBy: line.by,
      doc: parsed.data,
      approved: check.value,
    });
  }

  #line(event: IndexLine["event"], id: DocId, rev: Rev, hash: string, by: string): IndexLine {
    return {
      event,
      kind: this.#kind.name,
      id,
      rev,
      path: `${id}/${rev}.json`,
      hash,
      by,
      at: this.#clock.now().toISOString(),
    };
  }
}

/** Schemas for a candidate folder's files and its decision lines. */
export type CandidateSchemas<F extends Record<string, unknown>, D> = {
  files: { [K in keyof F]: z.ZodType<F[K]> };
  decision: z.ZodType<D>;
};

/** A candidate id's `<app>/<capability>` prefix, which sealing writes under (section 9 §6.2). */
function artifactIdOf(id: DocId): string {
  const cut = id.indexOf("/", id.indexOf("/") + 1);
  if (cut < 0) throw new Error(`candidate id has no app/capability: ${id}`);
  return id.slice(0, cut);
}

/** One sealed artifact version, kept in memory. */
type SealedArtifact = { artifact: unknown; crops: Map<string, Uint8Array> };

/** In-memory candidate store. */
export class FakeCandidateStore<F extends Record<string, unknown>, D> implements CandidateStore<
  F,
  D
> {
  readonly #schemas: CandidateSchemas<F, D>;
  readonly #clock: Clock;
  readonly #folders = new Map<DocId, { files: Map<string, unknown>; decisions: unknown[] }>();
  readonly #sealed = new Map<string, SealedArtifact>();
  readonly #artifactIndex: IndexLine[] = [];

  /** A store whose files and decisions follow `schemas`. */
  constructor(schemas: CandidateSchemas<F, D>, clock: Clock) {
    this.#schemas = schemas;
    this.#clock = clock;
  }

  /** Writes one file. */
  putFile<K extends keyof F & string>(
    id: DocId,
    name: K,
    data: F[K],
  ): Promise<Outcome<void, "write_failed">> {
    this.#folder(id).files.set(name, roundTrip(data));
    return Promise.resolve(ok(undefined));
  }

  /** Reads one file. */
  getFile<K extends keyof F & string>(
    id: DocId,
    name: K,
  ): Promise<Outcome<F[K], "not_found" | "invalid">> {
    assertSafeRelPath(id);
    const files = this.#folders.get(id)?.files;
    if (!files?.has(name)) return Promise.resolve(fail("not_found", `${id}/${name}`));
    const parsed = this.#schemas.files[name].safeParse(files.get(name));
    return Promise.resolve(
      parsed.success ? ok(parsed.data) : fail("invalid", issues(parsed.error)),
    );
  }

  /** Appends one decision. */
  appendDecision(id: DocId, decision: D): Promise<Outcome<void, "write_failed">> {
    this.#folder(id).decisions.push(roundTrip(decision));
    return Promise.resolve(ok(undefined));
  }

  /** Reads every decision. */
  decisions(id: DocId): Promise<Outcome<D[], "invalid">> {
    assertSafeRelPath(id);
    const out: D[] = [];
    for (const line of this.#folders.get(id)?.decisions ?? []) {
      const parsed = this.#schemas.decision.safeParse(line);
      if (!parsed.success) return Promise.resolve(fail("invalid", issues(parsed.error)));
      out.push(parsed.data);
    }
    return Promise.resolve(ok(out));
  }

  /** Lists candidate IDs, sorted. */
  list(): Promise<DocId[]> {
    return Promise.resolve([...this.#folders.keys()].sort());
  }

  /** Seals a candidate as one artifact version. Refuses a version already sealed. */
  seal(
    id: DocId,
    version: Rev,
    staff: string,
    artifact: unknown,
    crops: Record<string, Uint8Array>,
  ): Promise<Outcome<{ hash: string }, "conflict" | "write_failed" | "invalid">> {
    assertSafeRelPath(id);
    assertSafeRelPath(version);
    const artifactId = artifactIdOf(id);
    if (findLine(this.#artifactIndex, "sealed", artifactId, version))
      return Promise.resolve(fail("conflict", `${artifactId} ${version} is already sealed`));
    const hash = sealHash(artifact);
    const cropMap = new Map<string, Uint8Array>();
    for (const [targetId, bytes] of Object.entries(crops)) {
      assertSafeName(targetId);
      cropMap.set(targetId, bytes);
    }
    this.#sealed.set(`${artifactId}@${version}`, { artifact: roundTrip(artifact), crops: cropMap });
    this.#artifactIndex.push({
      event: "sealed",
      kind: "artifact",
      id: artifactId,
      rev: version,
      path: `${artifactId}/${version}/artifact.json`,
      hash,
      by: staff,
      at: this.#clock.now().toISOString(),
    });
    return Promise.resolve(ok({ hash }));
  }

  /** Lists every version sealed for one artifact. */
  listSealedVersions(artifactId: string): Promise<string[]> {
    return Promise.resolve(
      this.#artifactIndex.filter((l) => l.event === "sealed" && l.id === artifactId).map((l) => l.rev),
    );
  }

  /** Reads back one sealed artifact version. */
  getSealedArtifact(artifactId: string, version: Rev): Promise<Outcome<unknown, "not_found" | "invalid">> {
    const found = this.#sealed.get(`${artifactId}@${version}`);
    if (!found) return Promise.resolve(fail("not_found", `${artifactId} ${version} is not sealed`));
    return Promise.resolve(ok(roundTrip(found.artifact)));
  }

  /** Test hook: reads back what `seal` wrote for one artifact version, or `null`. */
  sealed(
    artifactId: string,
    version: string,
  ): { artifact: unknown; crops: Record<string, Uint8Array>; index: IndexLine[] } | null {
    const found = this.#sealed.get(`${artifactId}@${version}`);
    if (!found) return null;
    const crops: Record<string, Uint8Array> = {};
    for (const [targetId, bytes] of found.crops) crops[targetId] = bytes;
    const index = this.#artifactIndex.filter((l) => l.id === artifactId && l.rev === version);
    return { artifact: found.artifact, crops, index };
  }

  #folder(id: DocId): { files: Map<string, unknown>; decisions: unknown[] } {
    assertSafeRelPath(id);
    let folder = this.#folders.get(id);
    if (!folder) {
      folder = { files: new Map(), decisions: [] };
      this.#folders.set(id, folder);
    }
    return folder;
  }
}

/** In-memory log store. */
export class FakeLogStore<L, R> implements LogStore<L, R> {
  readonly #schemas: { line: z.ZodType<L>; record: z.ZodType<R> };
  readonly #logs = new Map<string, unknown[]>();
  readonly #records = new Map<string, unknown>();

  /** A store whose lines and records follow `schemas`. */
  constructor(schemas: { line: z.ZodType<L>; record: z.ZodType<R> }) {
    this.#schemas = schemas;
  }

  /** Appends one line. */
  append(key: string, line: L): Promise<Outcome<void, "write_failed">> {
    assertSafeRelPath(key);
    const log = this.#logs.get(key) ?? [];
    log.push(roundTrip(line));
    this.#logs.set(key, log);
    return Promise.resolve(ok(undefined));
  }

  /** Reads every line. */
  lines(key: string): Promise<Outcome<L[], "invalid">> {
    assertSafeRelPath(key);
    const out: L[] = [];
    for (const line of this.#logs.get(key) ?? []) {
      const parsed = this.#schemas.line.safeParse(line);
      if (!parsed.success) return Promise.resolve(fail("invalid", issues(parsed.error)));
      out.push(parsed.data);
    }
    return Promise.resolve(ok(out));
  }

  /** Replaces the record. */
  putRecord(key: string, record: R): Promise<Outcome<void, "write_failed">> {
    assertSafeRelPath(key);
    this.#records.set(key, roundTrip(record));
    return Promise.resolve(ok(undefined));
  }

  /** Reads the record. */
  getRecord(key: string): Promise<Outcome<R, "not_found" | "invalid">> {
    assertSafeRelPath(key);
    if (!this.#records.has(key)) return Promise.resolve(fail("not_found", key));
    const parsed = this.#schemas.record.safeParse(this.#records.get(key));
    return Promise.resolve(
      parsed.success ? ok(parsed.data) : fail("invalid", issues(parsed.error)),
    );
  }
}

/** One fake run folder's contents. */
type FakeRun = { events: unknown[]; files: Map<string, string | Uint8Array>; runJson?: unknown };

/** In-memory run folder. */
class FakeRunFolder implements RunFolder {
  readonly runId: string;
  readonly #run: FakeRun;
  readonly #store: FakeEvidenceStore;

  constructor(runId: string, run: FakeRun, store: FakeEvidenceStore) {
    this.runId = runId;
    this.#run = run;
    this.#store = store;
  }

  // Why no options: memory has no disk to flush, so `durable` changes nothing here.
  appendEvent(line: Masked<unknown>): Promise<Outcome<void, "write_failed">> {
    if (this.#store.failWrites) return Promise.resolve(fail("write_failed", "fake write failure"));
    this.#run.events.push(roundTrip(line));
    return Promise.resolve(ok(undefined));
  }

  writeFile(
    path: string,
    bytes: Masked<string> | Masked<Uint8Array>,
  ): Promise<Outcome<{ sha256: string; bytes: number }, "write_failed">> {
    assertSafeRelPath(path);
    if (this.#store.failWrites) return Promise.resolve(fail("write_failed", "fake write failure"));
    this.#run.files.set(path, bytes);
    const size = typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength;
    return Promise.resolve(ok({ sha256: sha256Hex(bytes), bytes: size }));
  }

  writeRunJson(run: Masked<unknown>): Promise<Outcome<void, "write_failed">> {
    if (this.#store.failWrites) return Promise.resolve(fail("write_failed", "fake write failure"));
    this.#run.runJson = roundTrip(run);
    return Promise.resolve(ok(undefined));
  }

  /** Reads one file already in the folder. Read-only: never touches the folder. */
  readFile(path: string): Promise<Outcome<Uint8Array, "not_found">> {
    assertSafeRelPath(path);
    const bytes = this.#run.files.get(path);
    if (bytes === undefined) return Promise.resolve(fail("not_found", path));
    return Promise.resolve(
      ok(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes),
    );
  }
}

/** In-memory evidence store. Set `failWrites` to make every write return `write_failed`. */
export class FakeEvidenceStore implements EvidenceStore {
  /** When true, every write returns `write_failed`. Tests of the write-ahead rule use it. */
  failWrites = false;
  readonly #tenants = new Map<string, { runs: Map<string, FakeRun>; index: unknown[] }>();

  /** Creates a run folder. */
  createRun(
    tenant: string,
    runId: string,
  ): Promise<Outcome<RunFolder, "conflict" | "write_failed">> {
    const t = this.#tenant(tenant);
    assertSafeName(runId);
    if (t.runs.has(runId)) return Promise.resolve(fail("conflict", `${runId} exists`));
    if (this.failWrites) return Promise.resolve(fail("write_failed", "fake write failure"));
    const run: FakeRun = { events: [], files: new Map() };
    t.runs.set(runId, run);
    return Promise.resolve(ok(new FakeRunFolder(runId, run, this)));
  }

  /** Opens a run folder. */
  openRun(tenant: string, runId: string): Promise<Outcome<RunFolder, "not_found">> {
    const run = this.#run(tenant, runId);
    return Promise.resolve(
      run ? ok(new FakeRunFolder(runId, run, this)) : fail("not_found", runId),
    );
  }

  /** Reads `run.json`. */
  readRunJson(tenant: string, runId: string): Promise<Outcome<unknown, "not_found" | "invalid">> {
    const run = this.#run(tenant, runId);
    if (run?.runJson === undefined) return Promise.resolve(fail("not_found", `${runId}/run.json`));
    return Promise.resolve(ok(roundTrip(run.runJson)));
  }

  /** Reads the run log. */
  events(tenant: string, runId: string): Promise<Outcome<unknown[], "not_found" | "invalid">> {
    const run = this.#run(tenant, runId);
    return Promise.resolve(run ? ok(run.events.map(roundTrip)) : fail("not_found", runId));
  }

  /** Appends to the tenant index. */
  appendIndex(tenant: string, line: Masked<unknown>): Promise<Outcome<void, "write_failed">> {
    if (this.failWrites) return Promise.resolve(fail("write_failed", "fake write failure"));
    this.#tenant(tenant).index.push(roundTrip(line));
    return Promise.resolve(ok(undefined));
  }

  /** Reads the tenant index. */
  index(tenant: string): Promise<Outcome<unknown[], "invalid">> {
    return Promise.resolve(ok(this.#tenant(tenant).index.map(roundTrip)));
  }

  /** Lists run IDs, sorted. */
  listRuns(tenant: string): Promise<string[]> {
    return Promise.resolve([...this.#tenant(tenant).runs.keys()].sort());
  }

  #tenant(tenant: string): { runs: Map<string, FakeRun>; index: unknown[] } {
    assertSafeName(tenant);
    let t = this.#tenants.get(tenant);
    if (!t) {
      t = { runs: new Map(), index: [] };
      this.#tenants.set(tenant, t);
    }
    return t;
  }

  #run(tenant: string, runId: string): FakeRun | undefined {
    assertSafeName(runId);
    return this.#tenant(tenant).runs.get(runId);
  }
}
