// Proves the crash sweep (design section 7 §17, section 9 §7.8, §10.7): each row of the
// design's own commit-state table, a read_only capability's crash (no effect block), an
// artifact the sweep cannot resolve (effect included, with a note), a discovery crash (the
// thin shape), a live run left untouched, and an already-finished run skipped. M05 task 10.
import { describe, expect, test } from "vitest";
import { LockManager, type LockEnv } from "../../../src/core/locks/manager.js";
import { Artifact as ArtifactSchema } from "../../../src/core/model/artifact.js";
import { CandidateDecision } from "../../../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../../../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../../../src/core/model/candidate-runs.js";
import { RunJson } from "../../../src/core/model/run.js";
import { runSweep, type SweepDeps } from "../../../src/core/orchestrator/sweep.js";
import type { Masked } from "../../../src/ports/masked.js";
import { ManualClock } from "../../../src/fakes/clock.js";
import { MemoryLockSlots } from "../../../src/fakes/locks.js";
import { FakeCandidateStore, FakeEvidenceStore } from "../../../src/fakes/stores.js";
import { OPEN_SUB, SIGN_IN } from "../replay/executor-harness.js";

const TENANT = "keystone";

function maskedCast<T>(v: T): Masked<T> {
  return v as Masked<T>;
}

/** One `events.jsonl` line, hand-built (the sweep reads only seq/at/step/event/data). */
function line(seq: number, at: string, step: string | null, event: string, data: unknown): unknown {
  return { seq, at, run_id: "unused", step, by: "engine", event, data };
}

/** `run_start`'s own `data`, freezing one artifact reference. */
function runStartData(artifactId: string, requestId: string): unknown {
  return { frozen: { artifact: { id: artifactId, hash: `sha256:${"a".repeat(64)}` } }, request_id: requestId };
}

/** A fresh evidence store, a lock manager over its own memory slots, a clock, and both fixture
 * artifacts sealed (`kvfcu/sign_in@1.0.0`, read_only; `kvfcu/open_sub@1.0.0`, commits). */
async function harness(): Promise<SweepDeps> {
  const clock = new ManualClock("2026-01-15T09:00:00.000Z");
  const env: LockEnv = { host: "test-host", pid: 1, isAlive: () => true };
  const store = new FakeCandidateStore(
    {
      files: { "runs.json": CandidateRuns, "candidate.json": ArtifactSchema, "issues.json": CandidateIssues },
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
  };
}

/** Writes a crash candidate: a run folder with `events`, and a tenant-index line naming it
 * `running` (or `escalated`), but never a `run.json` and never a held "run" lock — exactly
 * what the sweep looks for. */
async function seedCrashedRun(
  deps: SweepDeps,
  runId: string,
  opts: { kind: "discovery" | "replay"; capability: string; status?: "running" | "escalated"; events: unknown[] },
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
async function readBack(deps: SweepDeps, runId: string): Promise<Record<string, unknown>> {
  const read = await deps.evidence.readRunJson(TENANT, runId);
  if (!read.ok) throw new Error(`readRunJson failed: ${read.failure}`);
  const parsed = RunJson.safeParse(read.value);
  if (!parsed.success) throw new Error(`run.json does not fit its schema: ${parsed.error.message}`);
  return parsed.data;
}

describe("runSweep: the design's own commit-state table (section 7 §17)", () => {
  test("no commit_intent: failed, internal_error, commit not_sent, safe_to_retry true", async () => {
    const deps = await harness();
    const runId = "run_2026-01-15_1000000010";
    await seedCrashedRun(deps, runId, {
      kind: "replay",
      capability: "kvfcu/open_sub",
      events: [
        line(1, "2026-01-15T09:00:00.000Z", null, "run_start", runStartData("kvfcu/open_sub@1.0.0", runId)),
        line(2, "2026-01-15T09:00:01.000Z", "type_member_id", "gate", {}),
      ],
    });

    const report = await runSweep(deps, TENANT);
    expect(report.closed).toBe(1);
    expect(report.manual).toBe(0);
    expect(report.runs?.[0]).toMatchObject({ runId, kind: "replay", commit: "not_sent" });

    const runJson = await readBack(deps, runId);
    const result = runJson.result as Record<string, unknown>;
    expect(result.status).toBe("failed");
    expect((result.failure as Record<string, unknown>).code).toBe("internal_error");
    expect((result.failure as Record<string, unknown>).safe_to_retry).toBe(true);
    expect(result.effect).toMatchObject({ commit: "not_sent", performed_by: null, sent_at: null });

    const events = await deps.evidence.events(TENANT, runId);
    if (!events.ok) throw new Error("events failed");
    const runEnd = events.value.find((e) => (e as { event: string }).event === "run_end");
    expect(runEnd).toMatchObject({
      data: { status: "failed", code: "internal_error", recovered_after_crash: true },
    });
  });

  test("commit_intent, then a later different step's own line: commit confirmed", async () => {
    const deps = await harness();
    const runId = "run_2026-01-15_1000000011";
    await seedCrashedRun(deps, runId, {
      kind: "replay",
      capability: "kvfcu/open_sub",
      events: [
        line(1, "2026-01-15T09:00:00.000Z", null, "run_start", runStartData("kvfcu/open_sub@1.0.0", runId)),
        line(2, "2026-01-15T09:00:01.000Z", "click_confirm", "commit_intent", {}),
        line(3, "2026-01-15T09:00:02.000Z", "read_account_number", "gate", {}),
      ],
    });

    const report = await runSweep(deps, TENANT);
    expect(report.manual).toBe(0);
    expect(report.runs?.[0]).toMatchObject({ runId, commit: "confirmed" });
    const runJson = await readBack(deps, runId);
    const result = runJson.result as Record<string, unknown>;
    expect((result.failure as Record<string, unknown>).safe_to_retry).toBe(false);
    expect(result.effect).toMatchObject({ commit: "confirmed", performed_by: "bot" });
  });

  test("commit_intent, nothing after: commit uncertain, safe_to_retry false, a manual case", async () => {
    const deps = await harness();
    const runId = "run_2026-01-15_1000000012";
    await seedCrashedRun(deps, runId, {
      kind: "replay",
      capability: "kvfcu/open_sub",
      events: [
        line(1, "2026-01-15T09:00:00.000Z", null, "run_start", runStartData("kvfcu/open_sub@1.0.0", runId)),
        line(2, "2026-01-15T09:00:01.000Z", "click_confirm", "commit_intent", {}),
      ],
    });

    const report = await runSweep(deps, TENANT);
    expect(report.manual).toBe(1);
    expect(report.runs?.[0]).toMatchObject({ runId, commit: "uncertain" });
    const runJson = await readBack(deps, runId);
    const result = runJson.result as Record<string, unknown>;
    expect((result.failure as Record<string, unknown>).safe_to_retry).toBe(false);
    expect(result.effect).toMatchObject({ commit: "uncertain", performed_by: "bot" });
  });
});

describe("runSweep: a read_only capability's crash carries no effect block", () => {
  test("sign_in (read_only): failed, internal_error, no effect at all", async () => {
    const deps = await harness();
    const runId = "run_2026-01-15_1000000013";
    await seedCrashedRun(deps, runId, {
      kind: "replay",
      capability: "kvfcu/sign_in",
      events: [line(1, "2026-01-15T09:00:00.000Z", null, "run_start", runStartData("kvfcu/sign_in@1.0.0", runId))],
    });

    const report = await runSweep(deps, TENANT);
    expect(report.runs?.[0]).toEqual({ runId, kind: "replay" });
    const runJson = await readBack(deps, runId);
    const result = runJson.result as Record<string, unknown>;
    expect(result.status).toBe("failed");
    expect("effect" in result).toBe(false);
  });
});

describe("runSweep: an artifact the sweep cannot resolve", () => {
  test("an unresolvable artifact still gets an effect block (the safe default), with a note", async () => {
    const deps = await harness();
    const runId = "run_2026-01-15_1000000014";
    await seedCrashedRun(deps, runId, {
      kind: "replay",
      capability: "kvfcu/vanished_cap",
      events: [line(1, "2026-01-15T09:00:00.000Z", null, "run_start", runStartData("kvfcu/vanished_cap@9.9.9", runId))],
    });

    const report = await runSweep(deps, TENANT);
    expect(report.runs?.[0]).toMatchObject({ runId, commit: "not_sent" });
    const runJson = await readBack(deps, runId);
    const result = runJson.result as Record<string, unknown>;
    expect(result.effect).toMatchObject({ commit: "not_sent" });
    expect((result.failure as Record<string, unknown>).message).toContain("could not be confirmed");
  });
});

describe("runSweep: a discovery crash gets the thin shape", () => {
  test("failed, internal_error, no result/effect concept at all", async () => {
    const deps = await harness();
    const runId = "run_2026-01-15_1000000015";
    await seedCrashedRun(deps, runId, {
      kind: "discovery",
      capability: "kvfcu/sign_in",
      events: [line(1, "2026-01-15T09:00:00.000Z", null, "run_start", { schema: "intyy.log/1.0" })],
    });

    const report = await runSweep(deps, TENANT);
    expect(report.runs?.[0]).toEqual({ runId, kind: "discovery" });
    const runJson = await readBack(deps, runId);
    expect(runJson.kind).toBe("discovery");
    expect(runJson.status).toBe("failed");
    expect(runJson.code).toBe("internal_error");
    expect("result" in runJson).toBe(false);

    const events = await deps.evidence.events(TENANT, runId);
    if (!events.ok) throw new Error("events failed");
    const runEnd = events.value.find((e) => (e as { event: string }).event === "run_end");
    expect(runEnd).toMatchObject({ data: { recovered_after_crash: true } });
  });
});

describe("runSweep: live runs are left untouched", () => {
  test("a live replay (its run lock still held) is never swept", async () => {
    const deps = await harness();
    const runId = "run_2026-01-15_1000000016";
    await seedCrashedRun(deps, runId, {
      kind: "replay",
      capability: "kvfcu/open_sub",
      events: [line(1, "2026-01-15T09:00:00.000Z", null, "run_start", runStartData("kvfcu/open_sub@1.0.0", runId))],
    });
    const held = await deps.locks.acquire("run", runId, { owner: runId, command: "replay", staff: null, waitMs: 0 });
    if (!held.ok) throw new Error("test setup: could not hold the run lock");

    const report = await runSweep(deps, TENANT);
    expect(report.closed).toBe(0);
    const read = await deps.evidence.readRunJson(TENANT, runId);
    expect(read.ok).toBe(false);
    const index = await deps.evidence.index(TENANT);
    if (!index.ok) throw new Error("index failed");
    expect(index.value.some((l) => (l as { status: string }).status === "failed")).toBe(false);
  });

  test("a live discovery (its run lock still held) is never swept", async () => {
    const deps = await harness();
    const runId = "run_2026-01-15_1000000017";
    await seedCrashedRun(deps, runId, {
      kind: "discovery",
      capability: "kvfcu/sign_in",
      events: [line(1, "2026-01-15T09:00:00.000Z", null, "run_start", {})],
      status: "escalated",
    });
    const held = await deps.locks.acquire("run", runId, { owner: runId, command: "discover", staff: null, waitMs: 0 });
    if (!held.ok) throw new Error("test setup: could not hold the run lock");

    const report = await runSweep(deps, TENANT);
    expect(report.closed).toBe(0);
    const read = await deps.evidence.readRunJson(TENANT, runId);
    expect(read.ok).toBe(false);
  });

  test("an already-finished run (it already has a run.json) is skipped, not re-closed", async () => {
    const deps = await harness();
    const runId = "run_2026-01-15_1000000018";
    const created = await deps.evidence.createRun(TENANT, runId);
    if (!created.ok) throw new Error("test setup: createRun failed");
    await created.value.appendEvent(maskedCast(line(1, "2026-01-15T09:00:00.000Z", null, "run_start", {})));
    const original = RunJson.parse({
      schema: "intyy.run/1.0",
      run_id: runId,
      tenant: TENANT,
      kind: "discovery",
      capability: "kvfcu/sign_in",
      status: "success",
      code: null,
      started_at: "2026-01-15T09:00:00.000Z",
      ended_at: "2026-01-15T09:00:02.000Z",
      counts: { turns: 1, actions: 1, blocked: 0, invalid: 0 },
    });
    await created.value.writeRunJson(maskedCast(original));
    // Why "running" here: the index line is stale (never updated to the final status), the
    // one case §17's own check exists for — a `run.json` already answers the question.
    await deps.evidence.appendIndex(
      TENANT,
      maskedCast({ run_id: runId, at: "2026-01-15T09:00:00.000Z", status: "running", code: null, kind: "discovery" }),
    );

    const report = await runSweep(deps, TENANT);
    expect(report.closed).toBe(0);
    const runJson = await readBack(deps, runId);
    expect(runJson.status).toBe("success"); // unchanged: never re-closed as failed
    const events = await deps.evidence.events(TENANT, runId);
    if (!events.ok) throw new Error("events failed");
    expect(events.value).toHaveLength(1); // no run_end appended a second time
  });
});
