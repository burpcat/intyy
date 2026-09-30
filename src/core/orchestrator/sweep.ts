// The crash sweep (design section 7 §17, section 9 §7.8, §10.7): closes a run whose process
// crashed — no `run_end`, and no live run lock — as a hard failure, with `recovered_after_crash:
// true`. Every command runs this first, over its own tenant. Over ports only.
//
// A crashed replay's commit state comes straight from `events.jsonl`, per the design's own
// table: no `commit_intent` is `not_sent`; `commit_intent` with nothing else after it is
// `uncertain`; `commit_intent` followed by a later, *different* step's own line proves
// `confirmed` — the executor's own loop (section 7 §4 point 7) only ever reaches a step after
// the commit step once that commit is confirmed, so no separate checkpoint line is needed to
// prove it. A crashed discovery gets the thin shape: `failed`, `internal_error`, no effect block
// (owner decision, 2026-09-29).
import type { Clock } from "../../ports/clock.js";
import type { Locks } from "../../ports/locks.js";
import type { EvidenceStore, RunFolder } from "../../ports/stores.js";
import { readArtifact, type ArtifactStore } from "../catalog/artifacts.js";
import { sha256Hex } from "../model/canonical.js";
import { CommitState, Result } from "../model/result.js";
import { RunJson } from "../model/run.js";
import { Redactor, type RedactionRules } from "../safety/redaction/redactor.js";

/** What the sweep needs. A tenant's evidence and its run locks; the clock for `ended_at`; the
 * sealed artifact store, to tell a `commits` capability's crash from a `read_only` one's. */
export type SweepDeps = { evidence: EvidenceStore; locks: Locks; clock: Clock; artifacts: ArtifactStore };

/** One run the sweep closed. `commit` is set for a replay only. */
export type SweptRun = { runId: string; kind: "discovery" | "replay"; commit?: CommitState };

/** What one sweep pass did (section 9 §10.7). `runs` is the detail `run sweep` lists; a plain
 * `{ closed, manual }` (the pre-M05 shape) still fits, with no detail to show. */
export type SweepReport = { closed: number; manual: number; runs?: SweptRun[] };

/**
 * A rule set that masks nothing (every detector and format list is empty; the digit-run floor
 * is set past any real digit run). Everything the sweep writes is either an ID, a hash, or a
 * path it made itself, or text already masked once by the run's own process before it crashed —
 * scanning it again could only corrupt it (docs/decisions.md, M05). `Redactor.value` is still
 * the one sanctioned way to get the branded `Masked` value `writeRunJson`/`appendIndex` need.
 */
const NOOP_RULES: RedactionRules = {
  detectors: [],
  digitRunMin: 1_000_000,
  formats: [],
  labels: {},
  dateFormats: [],
};

/** One tenant index line, read back loosely (its own shape; not a released evidence format). */
type IndexRow = { run_id: string; status: string; kind?: string; capability?: string };

/** The newest index line per run ID, in first-seen order (the index's last status counts). */
function latestRows(lines: readonly unknown[]): IndexRow[] {
  const rows = new Map<string, IndexRow>();
  for (const line of lines) {
    if (typeof line !== "object" || line === null) continue;
    const l = line as Record<string, unknown>;
    if (typeof l.run_id !== "string" || typeof l.status !== "string") continue;
    rows.set(l.run_id, {
      run_id: l.run_id,
      status: l.status,
      ...(typeof l.kind === "string" ? { kind: l.kind } : {}),
      ...(typeof l.capability === "string" ? { capability: l.capability } : {}),
    });
  }
  return [...rows.values()];
}

/** One `events.jsonl` line, read back loosely. */
type LogLine = { seq: number; at: string; step: string | null; event: string; data: unknown };

function asLogLines(lines: readonly unknown[]): LogLine[] {
  const out: LogLine[] = [];
  for (const line of lines) {
    if (typeof line !== "object" || line === null) continue;
    const l = line as Record<string, unknown>;
    if (typeof l.seq !== "number" || typeof l.at !== "string" || typeof l.event !== "string") continue;
    out.push({
      seq: l.seq,
      at: l.at,
      step: typeof l.step === "string" ? l.step : null,
      event: l.event,
      data: l.data,
    });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** The effect a crashed replay's log proves (section 7 §17's table). */
function crashedEffect(lines: readonly LogLine[]): { commit: CommitState; sentAt: string | null; step: string | null } {
  const intent = [...lines].reverse().find((l) => l.event === "commit_intent");
  if (intent === undefined) return { commit: "not_sent", sentAt: null, step: null };
  const laterOtherStep = lines.some((l) => l.seq > intent.seq && l.step !== null && l.step !== intent.step);
  return { commit: laterOtherStep ? "confirmed" : "uncertain", sentAt: intent.at, step: intent.step };
}

/** Safe to retry only when nothing was sent (matches the executor's own `safeToRetryOf` rule). */
function safeToRetryOf(commit: CommitState): boolean {
  return commit === "not_sent";
}

/** `run_start`'s own `data` object, or `undefined` if the log has none yet. */
function runStartData(lines: readonly LogLine[]): Record<string, unknown> | undefined {
  const line = lines.find((l) => l.event === "run_start");
  return line !== undefined && typeof line.data === "object" && line.data !== null
    ? (line.data as Record<string, unknown>)
    : undefined;
}

/** `frozen.artifact.id`, split into app, capability, and version, like `kvfcu`, `open_sub`,
 * `1.0.0` from `kvfcu/open_sub@1.0.0`. `null` if `run_start` never froze one (an early crash). */
function artifactRefOf(data: Record<string, unknown> | undefined): { app: string; capability: string; version: string } | null {
  const frozen = data?.frozen;
  const artifact =
    typeof frozen === "object" && frozen !== null ? (frozen as Record<string, unknown>).artifact : undefined;
  const id = typeof artifact === "object" && artifact !== null ? (artifact as Record<string, unknown>).id : undefined;
  if (typeof id !== "string" || !id.includes("@")) return null;
  const [name, version] = id.split("@");
  const cut = name?.indexOf("/") ?? -1;
  if (name === undefined || version === undefined || cut < 0) return null;
  return { app: name.slice(0, cut), capability: name.slice(cut + 1), version };
}

/** Whether the artifact this crashed run resolved is `commits` or `read_only` (section 3 §5.8:
 * `effect` belongs on a non-rejected `commits` result only). `"unknown"` when the run never
 * froze an artifact, or the sealed version can no longer be read — unsure counts as `commits`,
 * the safe side, wherever this is used. */
async function effectTypeOf(
  artifacts: ArtifactStore,
  data: Record<string, unknown> | undefined,
): Promise<"commits" | "read_only" | "unknown"> {
  const ref = artifactRefOf(data);
  if (ref === null) return "unknown";
  const got = await readArtifact(artifacts, ref.app, ref.capability, ref.version);
  return got.ok ? got.value.contract.effect : "unknown";
}

/** `ms` (epoch milliseconds) as a `YYYY-MM-DD` UTC date, for `run.json.retention`. */
function isoDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(ms);
}

const MS_PER_DAY = 86_400_000;

/** The crashed replay's typed result: `failed`, `internal_error`, with the effect the log proves
 * — present only for a `commits` capability (section 3 §5.8). `effectType` `"unknown"` (the
 * artifact could not be resolved) still includes it, the safe side, and says so in the message. */
function replayResult(
  runId: string,
  index: IndexRow,
  lines: readonly LogLine[],
  eff: ReturnType<typeof crashedEffect>,
  effectType: "commits" | "read_only" | "unknown",
  endedAt: string,
): Result {
  const data = runStartData(lines);
  const ref = artifactRefOf(data);
  const requestId = typeof data?.request_id === "string" ? data.request_id : null;
  const startedAt = lines.find((l) => l.event === "run_start")?.at ?? endedAt;
  const unsureNote =
    effectType === "unknown" ? " (its capability's effect type could not be confirmed; assuming commits)" : "";
  return Result.parse({
    schema: "intyy.result/1.0",
    run_id: runId,
    request_id: requestId,
    capability: {
      name: index.capability ?? (ref === null ? "unknown/unknown" : `${ref.app}/${ref.capability}`),
      version: ref?.version ?? null,
      patch_revision: null,
    },
    warnings: [],
    recoveries: [],
    interventions: [],
    timing: { started_at: startedAt, ended_at: endedAt, duration_ms: 0, human_ms: 0 },
    evidence: `runs/${runId}`,
    status: "failed",
    ...(effectType === "read_only"
      ? {}
      : {
          effect: {
            commit: eff.commit,
            performed_by: eff.commit === "not_sent" ? null : "bot",
            sent_at: eff.sentAt,
            attempts: [],
          },
        }),
    failure: {
      code: "internal_error",
      message: `the run's process crashed; the sweep closed it${unsureNote}`,
      step: eff.step,
      phase: "run",
      expected: { condition: "run", description: "the process crashed before the run finished" },
      // Why "unknown": the process is gone; there is no live screen left to observe.
      observed: { location: "unknown", checks: [] },
      attempts: 0,
      ladder: { rung: 0, verdict: "hard_failure", ref: "run" },
      transient: false,
      safe_to_retry: safeToRetryOf(eff.commit),
      files: [],
    },
  });
}

/** The single `events.jsonl` file entry for `run.json.files` (section 3 §7.3). Never throws: a
 * read failure just means an empty list, since the sweep must still be able to close the run. */
async function eventsFileEntry(folder: RunFolder, signal?: AbortSignal): Promise<{ path: string; sha256: string; bytes: number }[]> {
  const read = await folder.readFile("events.jsonl", signal);
  if (!read.ok) return [];
  return [{ path: "events.jsonl", sha256: `sha256:${sha256Hex(read.value)}`, bytes: read.value.byteLength }];
}

/** Closes one crashed run: writes `run.json`, `run_end`, and the tenant index line; releases
 * the run lock the sweep itself just took. Returns `null` when the run is still live (its lock
 * is held) and was left untouched. */
async function closeOne(deps: SweepDeps, tenant: string, index: IndexRow, redactor: Redactor): Promise<SweptRun | null> {
  const runId = index.run_id;
  const held = await deps.locks.acquire("run", runId, { owner: "sweep", command: "sweep", staff: null, waitMs: 0 });
  if (!held.ok) return null; // Why: busy means a live process still owns this run. Never touched.
  try {
    const opened = await deps.evidence.openRun(tenant, runId);
    if (!opened.ok) return null; // Why: the run folder itself is gone; nothing to close.
    const folder = opened.value;
    const eventsRead = await deps.evidence.events(tenant, runId);
    const lines = eventsRead.ok ? asLogLines(eventsRead.value) : [];
    const kind: "discovery" | "replay" = index.kind === "replay" ? "replay" : "discovery";
    const at = deps.clock.now().toISOString();
    const capability = index.capability ?? "unknown/unknown";
    const nextSeq = lines.length === 0 ? 1 : Math.max(...lines.map((l) => l.seq)) + 1;
    const runEndLine = {
      seq: nextSeq,
      at,
      run_id: runId,
      step: null,
      by: "engine",
      event: "run_end",
      data: { status: "failed", code: "internal_error", recovered_after_crash: true },
    };

    let swept: SweptRun;
    if (kind === "discovery") {
      const startedAt = lines.find((l) => l.event === "run_start")?.at ?? at;
      const runJson = RunJson.parse({
        schema: "intyy.run/1.0",
        run_id: runId,
        tenant,
        kind: "discovery",
        capability,
        status: "failed",
        code: "internal_error",
        started_at: startedAt,
        ended_at: at,
        counts: null,
      });
      await folder.appendEvent(redactor.value(runEndLine), { durable: true });
      await folder.writeRunJson(redactor.value(runJson));
      swept = { runId, kind };
    } else {
      const eff = crashedEffect(lines);
      const effectType = await effectTypeOf(deps.artifacts, runStartData(lines));
      const result = replayResult(runId, index, lines, eff, effectType, at);
      const runJson = RunJson.parse({
        schema: "intyy.run/1.0",
        run_id: runId,
        tenant,
        kind: "replay",
        capability,
        parent_run_id: null,
        batch_id: null,
        request_id: result.request_id,
        status: "failed",
        result,
        frozen: runStartData(lines)?.frozen ?? {},
        files: await eventsFileEntry(folder),
        retention: {
          debug_until: isoDate(deps.clock.now().getTime() + 30 * MS_PER_DAY),
          audit_until: isoDate(deps.clock.now().getTime() + 365 * MS_PER_DAY),
        },
      });
      await folder.appendEvent(redactor.value(runEndLine), { durable: true });
      await folder.writeRunJson(redactor.value(runJson));
      swept = effectType === "read_only" ? { runId, kind } : { runId, kind, commit: eff.commit };
    }
    await deps.evidence.appendIndex(
      tenant,
      redactor.value({ run_id: runId, at, status: "failed", code: "internal_error", kind, capability }),
    );
    return swept;
  } finally {
    await deps.locks.release(held.value);
  }
}

/**
 * Sweeps one tenant (section 7 §17, section 9 §7.8): every run whose latest tenant-index status
 * is `running` or `escalated` is a crash candidate. A run whose "run" lock is still held (a live
 * process) is left untouched, as is one that already has a `run.json` (not actually a crash).
 */
export async function runSweep(deps: SweepDeps, tenant: string): Promise<SweepReport> {
  const read = await deps.evidence.index(tenant);
  if (!read.ok) return { closed: 0, manual: 0, runs: [] };
  const candidates = latestRows(read.value).filter((r) => r.status === "running" || r.status === "escalated");
  const redactor = new Redactor(NOOP_RULES);
  const runs: SweptRun[] = [];
  for (const row of candidates) {
    const finalCheck = await deps.evidence.readRunJson(tenant, row.run_id);
    if (finalCheck.ok) continue; // Why: already has a run.json; not a crash after all.
    const swept = await closeOne(deps, tenant, row, redactor);
    if (swept !== null) runs.push(swept);
  }
  const manual = runs.filter((r) => r.commit === "uncertain").length;
  return { closed: runs.length, manual, runs };
}
