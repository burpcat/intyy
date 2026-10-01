// Rebuilds live lines from a tenant's run files: the repair for a failed live write.
// Follows design section 8 §5.2 (`live.jsonl` is an index of evidence; a rebuild command recreates it
// from `run.json` files) and section 9 §9.8 (`trust rebuild --from-evidence`).
import type { EvidenceStore } from "../../ports/stores.js";
import { Sha256Hash } from "../model/canonical.js";
import type { LiveLine } from "../model/live-line.js";
import { RunJson } from "../model/run.js";
import type { ScoreKey } from "../model/score.js";
import { keyPath } from "./keys.js";
import { liveLinesOf, readEvents } from "./live-class.js";

/** A plain object, or `null`. */
function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The `id` of a frozen artifact block, like `kvfcu/open_share_subaccount@1.0.0`, or `null`. */
function frozenId(block: unknown): string | null {
  const id = obj(block)?.id;
  return typeof id === "string" ? id : null;
}

/** The key an exact capability text names in this tenant and app version, or `null` when it does not fit. */
function keyFor(capability: string | null, tenant: string, appVersion: string): ScoreKey | null {
  if (capability === null || !/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_]*@\d+\.\d+\.\d+$/.test(capability)) return null;
  return { capability, tenant, app_version: appVersion, patch_revision: null };
}

/** Live lines by key path, from the tenant's finished replay and check runs, oldest run first. */
export type EvidenceLive = { byKey: Map<string, { key: ScoreKey; lines: LiveLine[] }>; unreadable: string[] };

/**
 * Reads every run of the tenant and builds the live lines each would have written. A run counts
 * only when it is a finished replay or check run outside a certify batch, not a commit-retry child,
 * that resolved a versioned artifact (the same rule as the live hook). A run file it cannot read is
 * listed in `unreadable` and left out.
 */
export async function liveFromEvidence(
  evidence: EvidenceStore,
  tenant: string,
  signal?: AbortSignal,
): Promise<EvidenceLive> {
  const out: EvidenceLive = { byKey: new Map(), unreadable: [] };
  const put = (key: ScoreKey, line: LiveLine): void => {
    const path = keyPath(key);
    const entry = out.byKey.get(path) ?? { key, lines: [] };
    entry.lines.push(line);
    out.byKey.set(path, entry);
  };
  for (const runId of await evidence.listRuns(tenant, signal)) {
    const raw = await evidence.readRunJson(tenant, runId, signal);
    const parsed = raw.ok ? RunJson.safeParse(raw.value) : null;
    if (parsed === null || !parsed.success) {
      out.unreadable.push(runId);
      continue;
    }
    const run = parsed.data;
    if (run.kind === "discovery" || run.batch_id !== null) continue;
    const endedAt = run.result.timing.ended_at;
    if (endedAt === null) continue;
    const events = await evidence.events(tenant, runId, signal);
    const list = events.ok ? events.value : [];
    const facts = readEvents(list);
    if (facts.purpose === "commit_retry") continue;
    // Why `frozen.frozen`: `run.json.frozen` copies the whole `run_start` data, and its own `frozen` block holds the facts.
    const frozen = obj(run.frozen.frozen) ?? {};
    const appVersion = typeof frozen.app_version === "string" ? frozen.app_version : null;
    if (appVersion === null) continue;
    const taskKey = keyFor(frozenId(frozen.artifact), tenant, appVersion);
    if (taskKey === null) continue;
    const handlerSet = Sha256Hash.safeParse(frozen.handler_set);
    const lines = liveLinesOf({
      runId,
      at: endedAt,
      mode: facts.mode ?? "supervised",
      kind: run.kind,
      result: run.result,
      events: list,
      under: {
        engine: typeof frozen.engine_version === "string" ? frozen.engine_version : "unknown",
        handler_set: handlerSet.success ? handlerSet.data : null,
        jev: null,
      },
    });
    put(taskKey, lines.main);
    const sessionKey = keyFor(frozenId(frozen.session), tenant, appVersion);
    if (sessionKey !== null && lines.prelude !== null) put(sessionKey, lines.prelude);
  }
  return out;
}

/**
 * Merges the evidence's lines into a key's existing live lines. A line is the same when its run ID and
 * `as` match: the evidence's version wins. An existing line with no run file (retention removed it) is
 * kept, so a rebuild never loses what evidence no longer holds. Sorted by time, then run ID.
 */
export function mergeLive(existing: readonly LiveLine[], fromEvidence: readonly LiveLine[]): LiveLine[] {
  const id = (l: LiveLine): string => `${l.run_id}/${l.as}`;
  const seen = new Set(fromEvidence.map(id));
  return [...existing.filter((l) => !seen.has(id(l))), ...fromEvidence].sort(
    (a, b) => a.at.localeCompare(b.at) || a.run_id.localeCompare(b.run_id),
  );
}
