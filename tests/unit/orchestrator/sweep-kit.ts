// Shared helpers for the crash-sweep tests: a harness (evidence, locks, clock, sealed fixture
// artifacts), hand-built log lines, and a seeded crashed run. Not a test file. Design section 7 §17.
import { LockManager, type LockEnv } from "../../../src/core/locks/manager.js";
import { Artifact as ArtifactSchema } from "../../../src/core/model/artifact.js";
import { CandidateDecision } from "../../../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../../../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../../../src/core/model/candidate-runs.js";
import { RunJson } from "../../../src/core/model/run.js";
import type { SweepDeps } from "../../../src/core/orchestrator/sweep.js";
import type { Masked } from "../../../src/ports/masked.js";
import type { InterventionDesk } from "../../../src/ports/operator.js";
import { ManualClock } from "../../../src/fakes/clock.js";
import { MemoryLockSlots } from "../../../src/fakes/locks.js";
import { FakeCandidateStore, FakeEvidenceStore } from "../../../src/fakes/stores.js";
import { OPEN_SUB, SIGN_IN } from "../replay/executor-harness.js";

export const TENANT = "keystone";

export function maskedCast<T>(v: T): Masked<T> {
  return v as Masked<T>;
}

/** One `events.jsonl` line, hand-built (the sweep reads only seq/at/step/event/data). */
export function line(seq: number, at: string, step: string | null, event: string, data: unknown): unknown {
  return { seq, at, run_id: "unused", step, by: "engine", event, data };
}

/** `run_start`'s own `data`, freezing one artifact reference. */
export function runStartData(artifactId: string, requestId: string): unknown {
  return {
    frozen: { artifact: { id: artifactId, hash: `sha256:${"a".repeat(64)}` } },
    request_id: requestId,
  };
}

/** A fresh evidence store, a lock manager over its own memory slots, a clock, and both fixture
 * artifacts sealed (`kvfcu/sign_in@1.0.0`, read_only; `kvfcu/open_sub@1.0.0`, commits). */
export async function harness(desk?: InterventionDesk): Promise<SweepDeps> {
  const clock = new ManualClock("2026-01-15T09:00:00.000Z");
  const env: LockEnv = { host: "test-host", pid: 1, isAlive: () => true };
  const store = new FakeCandidateStore(
    {
      files: {
        "runs.json": CandidateRuns,
        "candidate.json": ArtifactSchema,
        "issues.json": CandidateIssues,
      },
      decision: CandidateDecision,
    },
    clock,
  );
  await store.seal("kvfcu/sign_in/cand_2026-01-15_1000000001", "1.0.0", "op_017", SIGN_IN, {});
  await store.seal("kvfcu/open_sub/cand_2026-01-15_1000000002", "1.0.0", "op_017", OPEN_SUB, {});
  return {
    evidence: new FakeEvidenceStore(),
    locks: new LockManager(new MemoryLockSlots(), clock, env),
    clock,
    artifacts: store,
    ...(desk === undefined ? {} : { desk }),
  };
}

/** Writes a crash candidate: a run folder with `events`, and a tenant-index line naming it
 * `running` (or `escalated`), but never a `run.json` and never a held "run" lock — exactly
 * what the sweep looks for. */
export async function seedCrashedRun(
  deps: SweepDeps,
  runId: string,
  opts: {
    kind: "discovery" | "replay";
    capability: string;
    status?: "running" | "escalated";
    events: unknown[];
  },
): Promise<void> {
  const created = await deps.evidence.createRun(TENANT, runId);
  if (!created.ok) throw new Error("test setup: createRun failed");
  for (const e of opts.events) await created.value.appendEvent(maskedCast(e));
  await deps.evidence.appendIndex(
    TENANT,
    maskedCast({
      run_id: runId,
      at: "2026-01-15T09:00:00.000Z",
      status: opts.status ?? "running",
      code: null,
      kind: opts.kind,
      capability: opts.capability,
    }),
  );
}

/** Reads back `run.json`, or fails the test. */
export async function readBack(deps: SweepDeps, runId: string): Promise<Record<string, unknown>> {
  const read = await deps.evidence.readRunJson(TENANT, runId);
  if (!read.ok) throw new Error(`readRunJson failed: ${read.failure}`);
  const parsed = RunJson.safeParse(read.value);
  if (!parsed.success) throw new Error(`run.json does not fit its schema: ${parsed.error.message}`);
  return parsed.data;
}

