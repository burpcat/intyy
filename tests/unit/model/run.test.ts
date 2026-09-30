// Proves `run.json` still parses the discovery shape M03/M04 write (byte-compatible, owner
// decision 2026-09-29), and accepts a replay shape following section 3 §7.3.
import { describe, expect, test } from "vitest";
import { ReplayRunStatus, RunJson, RunStatus } from "../../../src/core/model/run.js";

/** The exact fixture `tests/unit/recorder/seal.test.ts` writes today. */
function discoveryFixture(): Record<string, unknown> {
  return {
    schema: "intyy.run/1.0",
    run_id: "run_2026-09-24_7kq2m9x4tb",
    tenant: "keystone",
    kind: "discovery",
    capability: "kvfcu/sign_in",
    status: "success",
    code: null,
    started_at: "2026-09-24T10:00:00.000Z",
    ended_at: "2026-09-24T10:00:08.000Z",
    counts: { turns: 4, actions: 3, blocked: 0, invalid: 0 },
  };
}

/** A minimal result envelope, `running`, for embedding in a replay `run.json`. */
function runningResult(): Record<string, unknown> {
  return {
    schema: "intyy.result/1.0",
    run_id: "run_2026-09-24_7kq2m9x4tb",
    request_id: "agt-teller-7f3c-0042",
    capability: { name: "kvfcu/open_share_subaccount", version: "1.0.0", patch_revision: null },
    status: "running",
    warnings: [],
    recoveries: [],
    interventions: [],
    timing: { started_at: "2026-09-24T10:15:02.004Z", ended_at: null, duration_ms: 1000, human_ms: 0 },
    evidence: "runs/run_2026-09-24_7kq2m9x4tb/",
  };
}

/** Section 3 §7.3's replay example, filled in for a concrete parse. */
function replayFixture(): Record<string, unknown> {
  return {
    schema: "intyy.run/1.0",
    run_id: "run_2026-09-24_7kq2m9x4tb",
    kind: "replay",
    tenant: "keystone",
    capability: "kvfcu/open_share_subaccount",
    parent_run_id: null,
    batch_id: null,
    case_id: null,
    request_id: "agt-teller-7f3c-0042",
    status: "running",
    result: runningResult(),
    frozen: { models: null },
    files: [
      { path: "events.jsonl", sha256: `sha256:${"a".repeat(64)}`, bytes: 48213 },
      { path: "screens/00019_click_search_ladder.png", sha256: `sha256:${"b".repeat(64)}`, bytes: 184022 },
    ],
    retention: { debug_until: "2026-10-24", audit_until: "2027-09-24" },
  };
}

describe("intyy.run/1.0", () => {
  test("the discovery fixture M03/M04 already write still parses (byte-compatible)", () => {
    const parsed = RunJson.safeParse(discoveryFixture());
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === "discovery") {
      expect(parsed.data.capability).toBe("kvfcu/sign_in");
    }
  });

  test("a section 3 §7.3 replay run.json parses, ended_at nullable in its result", () => {
    expect(RunJson.safeParse(replayFixture()).success).toBe(true);
  });

  test("a replay run.json's top-level status accepts running and escalated; discovery does not", () => {
    for (const status of ReplayRunStatus.options) {
      expect(RunJson.safeParse({ ...replayFixture(), status }).success).toBe(true);
    }
    expect(RunStatus.options).toEqual(["success", "business_outcome", "rejected", "failed"]);
    expect(RunJson.safeParse({ ...discoveryFixture(), status: "running" }).success).toBe(false);
  });

  test("retention defaults land as dates (section 3 §7.9)", () => {
    const bad = { ...replayFixture(), retention: { debug_until: "not-a-date", audit_until: "2027-09-24" } };
    expect(RunJson.safeParse(bad).success).toBe(false);
  });

  test("an unknown kind is rejected", () => {
    expect(RunJson.safeParse({ ...discoveryFixture(), kind: "certify" }).success).toBe(false);
  });

  test("a discovery run.json with an unknown field is rejected", () => {
    expect(RunJson.safeParse({ ...discoveryFixture(), extra: true }).success).toBe(false);
  });
});
