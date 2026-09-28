// The document store on plain files: candidates, sealed revisions, and one index per store.
// Follows design section 9 §5.8, §6.2 (`<rev>.candidate.json` renames to `<rev>.json`), and §6.4.
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeRelPath } from "../../core/model/safe-path.js";
import {
  checkApprove,
  checkCandidate,
  checkSealed,
  findLine,
  sealHash,
  type DocKind,
} from "../../core/model/sealing.js";
import { IndexLine } from "../../core/model/store-index.js";
import type { Clock } from "../../ports/clock.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type {
  Candidate,
  DocFilter,
  DocId,
  DocSummary,
  DocumentStore,
  Rev,
  Sealed,
} from "../../ports/stores.js";
import {
  appendLine,
  prettyJson,
  readJson,
  readJsonLines,
  walkFiles,
  writeAtomic,
} from "./fs-util.js";

/** Where a file document store keeps its files. */
export type FileStoreDirs = {
  /** The store folder. Example: `<root>/library/policy`. */
  dir: string;
  /** Staging for atomic writes: `<root>/state/var/tmp`. */
  tmpDir: string;
};

const CANDIDATE = /^(.+)\/([^/]+)\.candidate\.json$/;

/** A document store for one record kind, on plain files. */
export class FileDocumentStore<T> implements DocumentStore<T> {
  readonly #kind: DocKind<T>;
  readonly #dirs: FileStoreDirs;
  readonly #clock: Clock;

  /** A store for `kind` in `dirs.dir`. */
  constructor(kind: DocKind<T>, dirs: FileStoreDirs, clock: Clock) {
    this.#kind = kind;
    this.#dirs = dirs;
    this.#clock = clock;
  }

  /** Reads a sealed revision and checks its hash against the index. */
  async get(
    id: DocId,
    rev: Rev,
  ): Promise<Outcome<Sealed<T>, "not_found" | "hash_mismatch" | "invalid">> {
    assertSafeRelPath(id);
    assertSafeRelPath(rev);
    const index = await this.#index();
    if (!index.ok) return index;
    const line = findLine(index.value, "sealed", id, rev);
    if (!line) return fail("not_found", `${id} ${rev} is not sealed`);
    const read = await readJson(this.#sealedPath(id, rev));
    if (read.kind === "missing") return fail("not_found", `${line.path} is missing`);
    if (read.kind === "bad") return fail("invalid", read.detail);
    const check = checkSealed(read.value, line, findLine(index.value, "approved", id, rev));
    if (!check.ok) return check;
    const parsed = this.#kind.schema.safeParse(read.value);
    if (!parsed.success) return fail("invalid", `${line.path}: ${parsed.error.message}`);
    return ok({
      id,
      rev,
      hash: line.hash,
      sealedBy: line.by,
      doc: parsed.data,
      approved: check.value,
    });
  }

  /** Reads the open candidate. */
  async getCandidate(id: DocId): Promise<Outcome<Candidate<T>, "not_found" | "invalid">> {
    assertSafeRelPath(id);
    const path = await this.#candidatePath(id);
    if (path === null) return fail("not_found", `no candidate for ${id}`);
    const read = await readJson(path);
    if (read.kind === "missing") return fail("not_found", `no candidate for ${id}`);
    if (read.kind === "bad") return fail("invalid", read.detail);
    const checked = checkCandidate(this.#kind, read.value);
    if (!checked.ok) return checked;
    return ok({ id, rev: this.#kind.revOf(checked.value), doc: checked.value });
  }

  /** Lists sealed revisions in index order, then candidates by ID. */
  async list(filter: DocFilter): Promise<DocSummary[]> {
    const index = await this.#index();
    if (!index.ok) throw new Error(index.detail);
    const out: DocSummary[] = [];
    for (const line of index.value) {
      if (line.event !== "sealed" || (filter.id !== undefined && line.id !== filter.id)) continue;
      const approved = findLine(index.value, "approved", line.id, line.rev) !== undefined;
      out.push({ id: line.id, rev: line.rev, state: approved ? "approved" : "sealed" });
    }
    for (const file of await walkFiles(this.#dirs.dir)) {
      const m = CANDIDATE.exec(file);
      if (!m?.[1] || !m[2] || (filter.id !== undefined && m[1] !== filter.id)) continue;
      out.push({ id: m[1], rev: m[2], state: "candidate" });
    }
    return out;
  }

  /** Writes the candidate as `<rev>.candidate.json`, replacing any other open candidate. */
  async putCandidate(id: DocId, doc: T): Promise<Outcome<void, "invalid" | "conflict">> {
    assertSafeRelPath(id);
    const checked = checkCandidate(this.#kind, doc);
    if (!checked.ok) return checked;
    const rev = this.#kind.revOf(checked.value);
    assertSafeRelPath(rev);
    const index = await this.#index();
    if (!index.ok) return index;
    if (findLine(index.value, "sealed", id, rev))
      return fail("conflict", `${id} ${rev} is already sealed`);
    const old = await this.#candidatePath(id);
    const path = join(this.#dirs.dir, id, `${rev}.candidate.json`);
    await writeAtomic(this.#dirs.tmpDir, path, prettyJson(doc));
    if (old !== null && old !== path) await rm(old, { force: true });
    return ok(undefined);
  }

  /** Renames the candidate to `<rev>.json`, then appends the `sealed` index line. */
  async seal(
    id: DocId,
    staff: string,
  ): Promise<Outcome<{ rev: Rev; hash: string }, "invalid" | "rule">> {
    assertSafeRelPath(id);
    const path = await this.#candidatePath(id);
    if (path === null) return fail("invalid", `no candidate for ${id}`);
    const read = await readJson(path);
    if (read.kind !== "ok")
      return fail("invalid", read.kind === "bad" ? read.detail : `no candidate for ${id}`);
    const checked = checkCandidate(this.#kind, read.value);
    if (!checked.ok) return checked;
    const rev = this.#kind.revOf(checked.value);
    const hash = sealHash(read.value);
    // ponytail: rename then append is not one step. A crash between them leaves a sealed file
    // with no index line, which reads as not_found. Fine for one human at a time.
    await rename(path, this.#sealedPath(id, rev));
    await this.#append(this.#line("sealed", id, rev, hash, staff));
    return ok({ rev, hash });
  }

  /** Writes the `approved` block once, then appends the `approved` index line. */
  async approve(
    id: DocId,
    rev: Rev,
    staff: string,
  ): Promise<Outcome<void, "rule" | "not_found" | "hash_mismatch" | "invalid">> {
    const got = await this.get(id, rev);
    if (!got.ok) return got;
    const rule = checkApprove(got.value.sealedBy, staff, got.value.approved);
    if (!rule.ok) return rule;
    const read = await readJson(this.#sealedPath(id, rev));
    if (read.kind !== "ok" || read.value === null || typeof read.value !== "object")
      return fail("invalid", `${id} ${rev} changed during approval`);
    const line = this.#line("approved", id, rev, got.value.hash, staff);
    await writeAtomic(
      this.#dirs.tmpDir,
      this.#sealedPath(id, rev),
      prettyJson({ ...read.value, approved: { by: line.by, at: line.at } }),
    );
    await this.#append(line);
    return ok(undefined);
  }

  /** The store's index lines, checked against `intyy.index/1.0`. */
  async #index(): Promise<Outcome<IndexLine[], "invalid">> {
    const read = await readJsonLines(join(this.#dirs.dir, "index.jsonl"));
    if (read === null) return ok([]);
    if (!read.ok) return fail("invalid", read.detail);
    const lines: IndexLine[] = [];
    for (const raw of read.lines) {
      const parsed = IndexLine.safeParse(raw);
      if (!parsed.success) return fail("invalid", `index.jsonl: ${parsed.error.message}`);
      if (parsed.data.kind === this.#kind.name) lines.push(parsed.data);
    }
    return ok(lines);
  }

  async #append(line: IndexLine): Promise<void> {
    await appendLine(join(this.#dirs.dir, "index.jsonl"), JSON.stringify(line), true);
  }

  /** The open candidate's path, or null. */
  async #candidatePath(id: DocId): Promise<string | null> {
    const prefix = `${id}/`;
    for (const file of await walkFiles(this.#dirs.dir)) {
      const m = CANDIDATE.exec(file);
      if (m?.[1] === id && file.startsWith(prefix)) return join(this.#dirs.dir, file);
    }
    return null;
  }

  #sealedPath(id: DocId, rev: Rev): string {
    return join(this.#dirs.dir, id, `${rev}.json`);
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
