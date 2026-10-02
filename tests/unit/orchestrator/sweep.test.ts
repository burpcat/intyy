// Proves the crash sweep (design section 7 §17, section 9 §7.8, §10.7): each row of the
// design's own commit-state table, a read_only capability's crash (no effect block), an
// artifact the sweep cannot resolve (effect included, with a note), a discovery crash (the
// thin shape), a live run left untouched, and an already-finished run skipped. M05 task 10.
import { describe, expect, test } from "vitest";
import { RunJson } from "../../../src/core/model/run.js";
import { runSweep } from "../../../src/core/orchestrator/sweep.js";
import { runReplay } from "../../../src/core/replay/executor.js";
import { buildHarness, fixtureSite, replayInputOf, requestOf } from "../replay/executor-harness.js";
import { TENANT, harness, line, maskedCast, readBack, runStartData, seedCrashedRun } from "./sweep-kit.js";

describe("runSweep: the design's own commit-state table (section 7 §17)", () => {
  test("the sweep reads each row of the commit-state table: not_sent, confirmed, uncertain, and the lines that prove nothing", async () => {
    // no commit_intent: failed, internal_error, commit not_sent, safe_to_retry true
    {
      const deps = await harness();
      const runId = "run_2026-01-15_1000000010";
      await seedCrashedRun(deps, runId, {
        kind: "replay",
        capability: "kvfcu/open_sub",
        events: [
          line(
            1,
            "2026-01-15T09:00:00.000Z",
            null,
            "run_start",
            runStartData("kvfcu/open_sub@1.0.0", runId),
          ),
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
    }
    // commit_intent, then an allowed engine gate line on a later step: commit confirmed
    {
      const deps = await harness();
      const runId = "run_2026-01-15_1000000011";
      await seedCrashedRun(deps, runId, {
        kind: "replay",
        capability: "kvfcu/open_sub",
        events: [
          line(
            1,
            "2026-01-15T09:00:00.000Z",
            null,
            "run_start",
            runStartData("kvfcu/open_sub@1.0.0", runId),
          ),
          line(2, "2026-01-15T09:00:01.000Z", "click_confirm", "commit_intent", {}),
          line(3, "2026-01-15T09:00:02.000Z", "read_account_number", "gate", { actor: "engine", decision: "allowed" }),
        ],
      });

      const report = await runSweep(deps, TENANT);
      expect(report.manual).toBe(0);
      expect(report.runs?.[0]).toMatchObject({ runId, commit: "confirmed" });
      const runJson = await readBack(deps, runId);
      const result = runJson.result as Record<string, unknown>;
      expect((result.failure as Record<string, unknown>).safe_to_retry).toBe(false);
      expect(result.effect).toMatchObject({ commit: "confirmed", performed_by: "bot" });
    }
    // commit_intent, then a line that proves no checkpoint passed: commit uncertain
    {
      const table: [string, string, string, unknown][] = [
        ["a gate line with empty data", "read_account_number", "gate", {}],
        ["a warning on a later step", "read_account_number", "warning", { code: "anything" }],
        ["an escalation on a later step", "read_account_number", "escalation", { kind: "takeover", state: "open" }],
        ["a human action line on a later step", "read_account_number", "action", { type: "click" }],
        ["an allowed engine gate line on a step before the commit", "type_member_id", "gate", { actor: "engine", decision: "allowed" }],
        ["a blocked engine gate line on a later step", "read_account_number", "gate", { actor: "engine", decision: "blocked" }],
        ["an allowed human gate line on a later step", "read_account_number", "gate", { actor: "human", decision: "allowed" }],
      ];
      for (const [name, step, event, data] of table) {
        const deps = await harness();
        const runId = "run_2026-01-15_1000000019";
        await seedCrashedRun(deps, runId, {
          kind: "replay",
          capability: "kvfcu/open_sub",
          events: [
            line(1, "2026-01-15T09:00:00.000Z", null, "run_start", runStartData("kvfcu/open_sub@1.0.0", runId)),
            line(2, "2026-01-15T09:00:01.000Z", "click_confirm", "commit_intent", {}),
            { ...(line(3, "2026-01-15T09:00:02.000Z", step, event, data) as object), by: event === "action" ? "human" : "engine" },
          ],
        });
        const report = await runSweep(deps, TENANT);
        expect(report.runs?.[0], name).toMatchObject({ runId, commit: "uncertain" });
        expect(report.manual, name).toBe(1);
      }
    }
    // commit_intent, nothing after: commit uncertain, safe_to_retry false, a manual case
    {
      const deps = await harness();
      const runId = "run_2026-01-15_1000000012";
      await seedCrashedRun(deps, runId, {
        kind: "replay",
        capability: "kvfcu/open_sub",
        events: [
          line(
            1,
            "2026-01-15T09:00:00.000Z",
            null,
            "run_start",
            runStartData("kvfcu/open_sub@1.0.0", runId),
          ),
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
    }
  });

  // Why: only a step after the commit step, reached through the executor's own loop, proves the
  // checkpoint passed. A warning, an escalation, a human line, or an empty gate line proves nothing
  // (section 7 §17: "a passed commit checkpoint").
});

describe("runSweep: a read_only capability's crash carries no effect block", () => {
  test("sign_in (read_only): failed, internal_error, no effect at all", async () => {
    const deps = await harness();
    const runId = "run_2026-01-15_1000000013";
    await seedCrashedRun(deps, runId, {
      kind: "replay",
      capability: "kvfcu/sign_in",
      events: [
        line(
          1,
          "2026-01-15T09:00:00.000Z",
          null,
          "run_start",
          runStartData("kvfcu/sign_in@1.0.0", runId),
        ),
      ],
    });

    const report = await runSweep(deps, TENANT);
    expect(report.runs?.[0]).toEqual({ runId, kind: "replay" });
    const runJson = await readBack(deps, runId);
    const result = runJson.result as Record<string, unknown>;
    expect(result.status).toBe("failed");
    expect("effect" in result).toBe(false);
  });
});

describe("runSweep: a REAL on-disk run log (written through RunLog and the redactor)", () => {
  test("a real read_only replay's own run_start resolves the effect type: no effect block", async () => {
    // Why a real replay: hand-built lines are never masked, so they missed the redactor turning
    // `kvfcu/sign_in@1.0.0` into `kvfcu/[email#1]` (section 3 §6.7; the crash sweep reads it).
    const h = await buildHarness(fixtureSite());
    const real = await runReplay(
      replayInputOf(h, requestOf({ capability: "kvfcu/sign_in@1", inputs: {} })),
      h.deps,
    );
    expect(real.result.status).toBe("success");
    const written = await h.deps.evidence.events(TENANT, real.runId);
    if (!written.ok) throw new Error("test setup: events failed");
    const runStart = written.value[0] as {
      event?: string;
      data?: { frozen?: { artifact?: { id?: string } } };
    };
    expect(runStart.event).toBe("run_start");
    expect(runStart.data?.frozen?.artifact?.id).toBe("kvfcu/sign_in@1.0.0");

    const deps = await harness();
    const runId = "run_2026-01-15_1000000015";
    await seedCrashedRun(deps, runId, {
      kind: "replay",
      capability: "kvfcu/sign_in",
      events: [runStart],
    });

    const report = await runSweep(deps, TENANT);
    expect(report.runs?.[0]).toEqual({ runId, kind: "replay" });
    const result = (await readBack(deps, runId)).result as Record<string, unknown>;
    expect("effect" in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain("could not be confirmed");
  });
});

describe("runSweep: an artifact the sweep cannot resolve", () => {
  test("an unresolvable artifact still gets an effect block (the safe default), with a note", async () => {
    const deps = await harness();
    const runId = "run_2026-01-15_1000000014";
    await seedCrashedRun(deps, runId, {
      kind: "replay",
      capability: "kvfcu/vanished_cap",
      events: [
        line(
          1,
          "2026-01-15T09:00:00.000Z",
          null,
          "run_start",
          runStartData("kvfcu/vanished_cap@9.9.9", runId),
        ),
      ],
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
      events: [
        line(
          1,
          "2026-01-15T09:00:00.000Z",
          null,
          "run_start",
          runStartData("kvfcu/open_sub@1.0.0", runId),
        ),
      ],
    });
    const held = await deps.locks.acquire("run", runId, {
      owner: runId,
      command: "replay",
      staff: null,
      waitMs: 0,
    });
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
    const held = await deps.locks.acquire("run", runId, {
      owner: runId,
      command: "discover",
      staff: null,
      waitMs: 0,
    });
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
    await created.value.appendEvent(
      maskedCast(line(1, "2026-01-15T09:00:00.000Z", null, "run_start", {})),
    );
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
      maskedCast({
        run_id: runId,
        at: "2026-01-15T09:00:00.000Z",
        status: "running",
        code: null,
        kind: "discovery",
      }),
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
