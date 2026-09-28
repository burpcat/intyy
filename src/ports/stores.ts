// The four store ports: document, candidate, log, and evidence. Each is typed per record kind.
// Follows design section 9 §5.8 and §6.4. The candidate, log, and evidence stores are the
// smallest shapes §5.8 needs (docs/decisions.md, M01). Later milestones extend them.
import type { Masked } from "./masked.js";
import type { Outcome } from "./outcome.js";

/** A document ID inside its store. Examples: `global`, `tenant/keystone`, `kvfcu/sign_in`. */
export type DocId = string;

/** A revision. A counting number for policy and settings (`"3"`), semver for artifacts (`"1.0.0"`). */
export type Rev = string;

/** The approval stamp written once into a sealed file (section 9 §6.4). */
export type Approval = { by: string; at: string };

/** A sealed revision, read back and hash-checked. */
export type Sealed<T> = {
  id: DocId;
  rev: Rev;
  /** `sha256:` plus hex, over canonical JSON without the `approved` block. */
  hash: string;
  sealedBy: string;
  doc: T;
  approved: Approval | null;
};

/** A candidate revision: not sealed yet, so it may still change. */
export type Candidate<T> = { id: DocId; rev: Rev; doc: T };

/** Which documents to list. */
export type DocFilter = { id?: DocId };

/** Where one revision is in its life. */
export type DocState = "candidate" | "sealed" | "approved";

/** One line of a listing. */
export type DocSummary = { id: DocId; rev: Rev; state: DocState };

/**
 * Candidate, then sealed revision, some also approved in-file (section 9 §5.8).
 * `rule` failures name the rule in `detail`. Example: `four_eyes`.
 * `invalid` means the file fails its schema; `hash_mismatch` means it changed after sealing.
 */
export interface DocumentStore<T> {
  /** Reads a sealed revision and checks its hash. */
  get(
    id: DocId,
    rev: Rev,
    signal?: AbortSignal,
  ): Promise<Outcome<Sealed<T>, "not_found" | "hash_mismatch" | "invalid">>;
  /** Reads the open candidate. Added for `check` and `edit`; §5.8 lists no read for candidates. */
  getCandidate(
    id: DocId,
    signal?: AbortSignal,
  ): Promise<Outcome<Candidate<T>, "not_found" | "invalid">>;
  /** Lists revisions, oldest first. */
  list(filter: DocFilter, signal?: AbortSignal): Promise<DocSummary[]>;
  /** Writes or replaces the candidate. `conflict`: that revision is already sealed. */
  putCandidate(
    id: DocId,
    doc: T,
    staff: string,
    signal?: AbortSignal,
  ): Promise<Outcome<void, "invalid" | "conflict">>;
  /** Freezes the candidate and writes the index line. */
  seal(
    id: DocId,
    staff: string,
    signal?: AbortSignal,
  ): Promise<Outcome<{ rev: Rev; hash: string }, "invalid" | "rule">>;
  /**
   * Stamps a sealed revision once. The approver is never the sealer: `rule`, detail `four_eyes`.
   * `not_found` and `hash_mismatch` are added to §5.8's list: approve reads the file first.
   */
  approve(
    id: DocId,
    rev: Rev,
    staff: string,
    signal?: AbortSignal,
  ): Promise<Outcome<void, "rule" | "not_found" | "hash_mismatch" | "invalid">>;
}

/**
 * A folder per artifact candidate: named files plus an append-only decision log (section 9 §6.2).
 * `F` maps file names to their types. Example: `{ "runs.json": Runs; "candidate.json": Draft }`.
 */
export interface CandidateStore<F extends Record<string, unknown>, D> {
  /** Writes one file atomically. Creates the folder if needed. */
  putFile<K extends keyof F & string>(
    id: DocId,
    name: K,
    data: F[K],
    signal?: AbortSignal,
  ): Promise<Outcome<void, "write_failed">>;
  /** Reads one file. */
  getFile<K extends keyof F & string>(
    id: DocId,
    name: K,
    signal?: AbortSignal,
  ): Promise<Outcome<F[K], "not_found" | "invalid">>;
  /** Appends one review decision. */
  appendDecision(
    id: DocId,
    decision: D,
    signal?: AbortSignal,
  ): Promise<Outcome<void, "write_failed">>;
  /** Reads every decision, in order. An absent log is empty. */
  decisions(id: DocId, signal?: AbortSignal): Promise<Outcome<D[], "invalid">>;
  /** Lists candidate IDs, sorted. */
  list(signal?: AbortSignal): Promise<DocId[]>;
}

/**
 * Append-only lines, plus records rebuilt from them (section 9 §5.8).
 * A key names one log and one record. Example: `keystone/kvfcu/open_share_subaccount@1.0.0/9.2/base/history`.
 */
export interface LogStore<L, R> {
  /** Appends one line. */
  append(key: string, line: L, signal?: AbortSignal): Promise<Outcome<void, "write_failed">>;
  /** Reads every line, in order. An absent log is empty. */
  lines(key: string, signal?: AbortSignal): Promise<Outcome<L[], "invalid">>;
  /** Replaces the rebuilt record atomically. */
  putRecord(key: string, record: R, signal?: AbortSignal): Promise<Outcome<void, "write_failed">>;
  /** Reads the rebuilt record. */
  getRecord(key: string, signal?: AbortSignal): Promise<Outcome<R, "not_found" | "invalid">>;
}

/** Options for one run log line. */
export type AppendOptions = {
  /** Force the line to disk before returning. The commit write-ahead rule needs it (section 3 §6.6). */
  durable?: boolean;
};

/** One run folder (section 3 §7.1). Masked data only. */
export interface RunFolder {
  /** The run this folder belongs to. */
  readonly runId: string;
  /** Appends one line to `events.jsonl`. A failed write returns `write_failed`; the run maps it to `evidence_write_failed`. */
  appendEvent(
    line: Masked<unknown>,
    opts?: AppendOptions,
    signal?: AbortSignal,
  ): Promise<Outcome<void, "write_failed">>;
  /** Writes one file inside the folder, such as `screens/00019_click_search_ladder.png`. Returns its hash and size. */
  writeFile(
    path: string,
    bytes: Masked<string> | Masked<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<Outcome<{ sha256: string; bytes: number }, "write_failed">>;
  /** Replaces `run.json` atomically: temp file first, then rename (section 3 §7.3). */
  writeRunJson(run: Masked<unknown>, signal?: AbortSignal): Promise<Outcome<void, "write_failed">>;
}

/** Run folders and the tenant's run index (section 9 §5.8). Batches and mailboxes come later. */
export interface EvidenceStore {
  /** Creates a new run folder. `conflict`: it already exists. */
  createRun(
    tenant: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<Outcome<RunFolder, "conflict" | "write_failed">>;
  /** Opens an existing run folder. */
  openRun(
    tenant: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<Outcome<RunFolder, "not_found">>;
  /** Reads `run.json`. The caller checks its schema. */
  readRunJson(
    tenant: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<Outcome<unknown, "not_found" | "invalid">>;
  /** Reads every line of `events.jsonl`, in order. */
  events(
    tenant: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<Outcome<unknown[], "not_found" | "invalid">>;
  /** Appends one line to the tenant's `index.jsonl`: one line per run status change. */
  appendIndex(
    tenant: string,
    line: Masked<unknown>,
    signal?: AbortSignal,
  ): Promise<Outcome<void, "write_failed">>;
  /** Reads the tenant's index. An absent index is empty. */
  index(tenant: string, signal?: AbortSignal): Promise<Outcome<unknown[], "invalid">>;
  /** Lists the tenant's run IDs, sorted. */
  listRuns(tenant: string, signal?: AbortSignal): Promise<string[]>;
}
