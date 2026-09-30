// The request index (section 3 §4.4, section 4 §8.11): tells a true repeat of a caller's
// request from the same ID reused with different content, and stores no content at all — only
// two keyed hashes, a run ID, and a time. A request enters the index only after pre-run checks
// 1 to 9 pass, just before check 10 (docs/decisions.md, M05); the lookup itself runs earlier,
// at check 3, so it needs the same signing key that early too.
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { Clock } from "../../ports/clock.js";
import { Secret } from "../../ports/secret.js";
import type { SecretBinding, Secrets } from "../../ports/secrets.js";
import type { LogStore } from "../../ports/stores.js";
import { canonicalJson, hmacSha256Hex } from "../model/canonical.js";
import type { Request } from "../model/request.js";
import { RequestIndexLine } from "../model/request-index.js";
import type { FailureCode } from "../model/result.js";

/** One signing key, as bank settings declare it (section 4 §8.11,
 * `system_secrets.request_index_keys`). Lookups try `current`, then `previous`; only entries
 * signed with `current` are ever written. */
export type RequestIndexKeySource = {
  keyId: string;
  status: "current" | "previous";
  binding: SecretBinding;
};

/** Days an entry stays a dedupe match, before it is ignored as expired (section 3 §4.4). */
export const DEFAULT_EXPIRY_DAYS = 7;

/** What the index needs to look up or record one request. */
export type RequestIndexDeps = {
  /** One log per tenant; the record side (`putRecord`/`getRecord`) is unused. */
  store: LogStore<RequestIndexLine, never>;
  clock: Clock;
  secrets: Secrets;
  keys: readonly RequestIndexKeySource[];
  /** `request_index.expiry_days` from policy; `undefined` uses {@link DEFAULT_EXPIRY_DAYS}. */
  expiryDays?: number;
};

/** Check 3's answer (section 3 §4.4). `runId` is the original run's ID; the caller loads its
 * result from `run.json`, since the index stores no result itself. */
export type RequestIdLookup =
  | { status: "new" }
  | { status: "repeat"; runId: string }
  | { status: "reused" };

/** One resolved signing key: its ID, and its raw value, in memory only. */
type ResolvedKey = { keyId: string; value: string };

/** The request's own ID. A caller must filter out `null` before calling this module; a `null`
 * here is a bug, since there is nothing to deduplicate (only bugs throw, per CLAUDE.md). */
function requireRequestId(request: Request): string {
  if (request.request_id === null) throw new Error("requestIndex: request_id is null");
  return request.request_id;
}

/** The content section 3 §4.4 and section 4 §8.11 both hash: capability, inputs, mode, and the
 * consent reference (or `null`). One definition, used for every lookup and every record. */
function contentSubject(request: Request): unknown {
  return {
    capability: request.capability,
    inputs: request.inputs,
    mode: request.mode,
    consent_ref: request.authorization?.consent_ref ?? null,
  };
}

/** Resolves the current key, and the previous key when the bank still has one bound and it
 * still resolves. Only the current key is required (section 4 §8.11). */
async function resolveKeys(
  deps: RequestIndexDeps,
  signal?: AbortSignal,
): Promise<Outcome<{ current: ResolvedKey; previous?: ResolvedKey }, "secret_unavailable">> {
  const currentSource = deps.keys.find((k) => k.status === "current");
  if (currentSource === undefined) {
    return fail("secret_unavailable", "no current request-index key is bound");
  }
  const current = await deps.secrets.resolve(currentSource.binding, signal);
  if (!current.ok) {
    return fail("secret_unavailable", `request-index key ${currentSource.keyId} has no value`);
  }
  const resolved: { current: ResolvedKey; previous?: ResolvedKey } = {
    current: { keyId: currentSource.keyId, value: Secret.open(current.value) },
  };
  const previousSource = deps.keys.find((k) => k.status === "previous");
  if (previousSource !== undefined) {
    const previous = await deps.secrets.resolve(previousSource.binding, signal);
    // Why: a missing previous key only loses old entries near a rotation boundary, so it does
    // not fail the whole lookup (section 4 §8.11: rotation needs no rewrite).
    if (previous.ok) resolved.previous = { keyId: previousSource.keyId, value: Secret.open(previous.value) };
  }
  return ok(resolved);
}

/** One key's lookup and content hash for one request, tagged with the key's own ID. */
function hashesUnder(key: ResolvedKey, lookupSubject: string, contentJson: string): { lookup: string; content: string } {
  return {
    lookup: `hmac-sha256:${key.keyId}:${hmacSha256Hex(key.value, lookupSubject)}`,
    content: `hmac-sha256:${key.keyId}:${hmacSha256Hex(key.value, contentJson)}`,
  };
}

/**
 * Check 3 (section 3 §4.4): is `request`'s ID new, a true repeat, or reused with different
 * content? Ignores an entry past `expiryDays`, so an expired ID starts a new run.
 */
export async function lookupRequestIndex(
  deps: RequestIndexDeps,
  tenant: string,
  agentId: string,
  request: Request,
  signal?: AbortSignal,
): Promise<Outcome<RequestIdLookup, "secret_unavailable" | "invalid">> {
  const requestId = requireRequestId(request);
  const keys = await resolveKeys(deps, signal);
  if (!keys.ok) return keys;
  const read = await deps.store.lines(tenant, signal);
  if (!read.ok) return fail("invalid", read.detail);

  const lookupSubject = canonicalJson([tenant, agentId, requestId]);
  const contentJson = canonicalJson(contentSubject(request));
  const tried = [keys.value.current, ...(keys.value.previous === undefined ? [] : [keys.value.previous])].map(
    (key) => ({ keyId: key.keyId, ...hashesUnder(key, lookupSubject, contentJson) }),
  );

  const cutoffMs = deps.clock.now().getTime() - (deps.expiryDays ?? DEFAULT_EXPIRY_DAYS) * 86_400_000;
  for (const line of read.value) {
    if (Date.parse(line.at) < cutoffMs) continue; // expired: ignore (section 3 §4.4)
    const match = tried.find((t) => line.lookup === t.lookup);
    if (match === undefined) continue;
    return ok(line.content === match.content ? { status: "repeat", runId: line.run_id } : { status: "reused" });
  }
  return ok({ status: "new" });
}

/**
 * Records a new request, once checks 1 to 9 have passed (section 3 §4.4, docs/decisions.md
 * M05). New entries always sign with the current key (section 4 §8.11).
 */
export async function recordRequestIndex(
  deps: RequestIndexDeps,
  tenant: string,
  agentId: string,
  request: Request,
  runId: string,
  signal?: AbortSignal,
): Promise<Outcome<void, "secret_unavailable" | "write_failed">> {
  const requestId = requireRequestId(request);
  const keys = await resolveKeys(deps, signal);
  if (!keys.ok) return keys;
  const lookupSubject = canonicalJson([tenant, agentId, requestId]);
  const contentJson = canonicalJson(contentSubject(request));
  const { lookup, content } = hashesUnder(keys.value.current, lookupSubject, contentJson);
  const line: RequestIndexLine = { lookup, content, run_id: runId, at: deps.clock.now().toISOString() };
  return deps.store.append(tenant, line, signal);
}

/** The two functions {@link PrecheckInput} injects, over `intyy.result/1.0`'s failure codes
 * (`invalid` folds into `internal_error`; `write_failed` folds into `evidence_write_failed`) so
 * `runPrechecks` can report either straight through as a `"failed"` outcome. */
export function requestIndexOps(deps: RequestIndexDeps): {
  lookup: (tenant: string, agentId: string, request: Request, signal?: AbortSignal) => Promise<Outcome<RequestIdLookup, FailureCode>>;
  record: (tenant: string, agentId: string, request: Request, runId: string, signal?: AbortSignal) => Promise<Outcome<void, FailureCode>>;
} {
  return {
    lookup: async (tenant, agentId, request, signal) => {
      const got = await lookupRequestIndex(deps, tenant, agentId, request, signal);
      if (got.ok) return got;
      return fail(got.failure === "invalid" ? "internal_error" : got.failure, got.detail);
    },
    record: async (tenant, agentId, request, runId, signal) => {
      const got = await recordRequestIndex(deps, tenant, agentId, request, runId, signal);
      if (got.ok) return got;
      return fail(got.failure === "write_failed" ? "evidence_write_failed" : got.failure, got.detail);
    },
  };
}
