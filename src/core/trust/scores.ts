// Score writes: append a history line, rebuild the record, replace it. One lock per tenant.
// Follows design section 8 §5.2 (record rebuilt, then replaced whole), §5.6 (writers and locks),
// and section 9 §9.8 (`trust rebuild`).
import type { LockRequest, Locks } from "../../ports/locks.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { ScoreStore } from "../../ports/scores.js";
import { canonicalJson, hashJson } from "../model/canonical.js";
import type { HistoryLine } from "../model/score-history.js";
import type { ScoreKey, ScoreRecord } from "../model/score.js";
import { sealHash } from "../model/sealing.js";
import { keyPath, parseKeyPath } from "./keys.js";
import { rebuild, type ScoreHashes } from "./rebuild.js";

/** How long a writer waits for the score lock. The lock is held for seconds at most (section 9 §12). */
export const SCORE_LOCK_WAIT_MS = 10_000;

/** The one thing score code needs from the artifact store: a sealed artifact's content. */
export interface SealedArtifacts {
  /** Reads a sealed artifact, hash-checked. `id` is `<app>/<capability>`. */
  getSealedArtifact(
    artifactId: string,
    version: string,
  ): Promise<Outcome<unknown, "not_found" | "invalid">>;
}

/** What score writers need. */
export type ScoreDeps = {
  scores: ScoreStore<HistoryLine, ScoreRecord>;
  locks: Locks;
  artifacts: SealedArtifacts;
};

/** Who writes, for the lock file (section 9 §12.1). `owner` is a batch or run ID. */
export type ScoreWriter = Pick<LockRequest, "owner" | "command" | "staff">;

/** Why a score write failed. `bad_history` names the line that breaks the rules. */
export type ScoreFailure = "busy" | "write_failed" | "invalid" | "bad_history";

/**
 * The record's hashes (section 8 §5.3). The artifact hash is the seal hash the store index
 * records. `null` when the artifact is not sealed here. The patch hash waits for patch keys, which no
 * command certifies yet, so it is `null` too.
 */
export async function hashesFor(artifacts: SealedArtifacts, key: ScoreKey): Promise<ScoreHashes> {
  const at = key.capability.indexOf("@");
  const sealed = await artifacts.getSealedArtifact(
    key.capability.slice(0, at),
    key.capability.slice(at + 1),
  );
  return { artifact: sealed.ok ? sealHash(sealed.value) : null, patch: null };
}

/** Runs `body` under the tenant's score lock. */
async function locked<T>(
  deps: ScoreDeps,
  key: ScoreKey,
  who: ScoreWriter,
  body: () => Promise<Outcome<T, ScoreFailure>>,
): Promise<Outcome<T, ScoreFailure>> {
  const got = await deps.locks.acquire("score", key.tenant, { ...who, waitMs: SCORE_LOCK_WAIT_MS });
  if (!got.ok) return fail("busy", got.detail);
  try {
    return await body();
  } finally {
    await deps.locks.release(got.value);
  }
}

/**
 * Appends one history line, then rebuilds and replaces the record. The line is checked against
 * the history first: an illegal move writes nothing (section 8 §4.2). Returns the new record.
 */
export function appendHistory(
  deps: ScoreDeps,
  key: ScoreKey,
  line: HistoryLine,
  who: ScoreWriter,
): Promise<Outcome<ScoreRecord, ScoreFailure>> {
  const path = keyPath(key);
  return locked(deps, key, who, async () => {
    const lines = await deps.scores.history(path);
    if (!lines.ok) return fail("invalid", lines.detail);
    const record = rebuild(key, await hashesFor(deps.artifacts, key), [...lines.value, line]);
    if (!record.ok) return record;
    const written = await deps.scores.append(path, line);
    if (!written.ok) return written;
    const put = await deps.scores.putRecord(path, record.value);
    return put.ok ? ok(record.value) : put;
  });
}

/** The result of one rebuild: the record before (`null` if none could be read) and after. */
export type Rebuilt = {
  key: ScoreKey;
  before: ScoreRecord | null;
  after: ScoreRecord;
  /** Top-level record fields whose content changed. All fields when there was no record before. */
  changed: string[];
  /** False for a key with no files at all: it stays a synthetic draft, and nothing is written. */
  written: boolean;
};

/** The top-level fields that differ between two records. */
export function changedFields(before: ScoreRecord | null, after: ScoreRecord): string[] {
  const names = Object.keys(after) as (keyof ScoreRecord)[];
  if (before === null) return names;
  return names.filter((n) => canonicalJson(before[n]) !== canonicalJson(after[n]));
}

/** Rebuilds one key's record from its history under the score lock, and replaces the file. */
export function rebuildKey(
  deps: ScoreDeps,
  key: ScoreKey,
  who: ScoreWriter,
): Promise<Outcome<Rebuilt, ScoreFailure>> {
  const path = keyPath(key);
  return locked<Rebuilt>(deps, key, who, async () => {
    const lines = await deps.scores.history(path);
    if (!lines.ok) return fail("invalid", lines.detail);
    const after = rebuild(key, await hashesFor(deps.artifacts, key), lines.value);
    if (!after.ok) return after;
    const old = await deps.scores.getRecord(path);
    const before = old.ok ? old.value : null;
    // Why: section 8 §5.2, "no record file means draft". An empty key gets no files from a rebuild.
    if (lines.value.length === 0 && !old.ok && old.failure === "not_found") {
      return ok({ key, before, after: after.value, changed: [], written: false });
    }
    const put = await deps.scores.putRecord(path, after.value);
    if (!put.ok) return put;
    return ok({ key, before, after: after.value, changed: changedFields(before, after.value), written: true });
  });
}

/** Every key of a tenant that has score files, and the folders that fit no key. */
export async function listKeys(
  scores: ScoreStore<HistoryLine, ScoreRecord>,
  tenant: string,
): Promise<{ keys: ScoreKey[]; skipped: string[] }> {
  const keys: ScoreKey[] = [];
  const skipped: string[] = [];
  for (const path of await scores.paths(tenant)) {
    const key = parseKeyPath(path);
    if (key === null) skipped.push(path);
    else keys.push(key);
  }
  return { keys, skipped };
}

/** The batch history line a certify path writes (section 8 §5.4, `batch`). */
export function batchLine(input: {
  at: Date;
  by: string;
  reason: string;
  batch: string;
  kind: "quick" | "full" | "regression";
  gatePassed: boolean;
  /** True for a drill batch: the line is history only (section 8 §7.1). */
  drill?: boolean;
  report: unknown;
  under: Extract<HistoryLine, { event: "batch" }>["under"];
  scores?: Extract<HistoryLine, { event: "batch" }>["scores"];
}): HistoryLine {
  return {
    event: "batch",
    at: input.at.toISOString(),
    by: input.by,
    reason: input.reason,
    batch: input.batch,
    kind: input.kind,
    ...(input.drill === true ? { drill: true as const } : {}),
    gate: input.gatePassed ? "passed" : "failed",
    // Why: the hash covers the report's canonical JSON, so file formatting never changes it.
    report_hash: hashJson(input.report),
    under: input.under,
    scores: input.scores ?? null,
  };
}
