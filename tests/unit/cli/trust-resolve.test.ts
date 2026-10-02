// Proves the resolver and check 7 through the CLI (design section 3 §4.8 check 7, §4.5; section 8
// §10.10 linked capabilities, §11.5 operator pin, §11.7, §11.8 what gets frozen; section 9 §11
// the capability catalog): unattended open-share is rejected until its session, its check, and the
// task are all approved (the test gate row), then succeeds; `replay --pin` works supervised only,
// for an exact key of the request's own capability and major, without a patch; a supervised pinned
// run freezes the pin; `run.json` freezes the approval state, batch, record hash, and the approved
// timeouts, or `draft` and nothing when there is no record; `capability list` and `describe` show
// approved, degraded, retired, or draft. Temporary data roots only. M10 task 6.
import { afterAll, describe, expect, test } from "vitest";
import { EXIT } from "../../../src/cli/exit-codes.js";
import type { HistoryLine } from "../../../src/core/model/score-history.js";
import type { Result } from "../../../src/core/model/result.js";
import type { ScoreKey } from "../../../src/core/model/score.js";
import { appendHistory } from "../../../src/core/trust/scores.js";
import { hashJson } from "../../../src/core/model/canonical.js";
import { approved, batch, degraded, KEY as BASE_KEY, retired } from "../trust/kit.js";
import { cleanRoots } from "./helpers.js";
import {
  MEMBER_FOUND,
  readRunJson,
  realWiringOf,
  replayCall,
  replayRoot,
  runSupervisedToEnd,
  writeAuthorization,
  writeInputs,
  type ReplayEnv,
} from "./replay-harness.js";

afterAll(cleanRoots);

const LONG = { timeout: 120_000 };

const keyOf = (capability: string): ScoreKey => ({ ...BASE_KEY, capability, app_version: "8.4" });
const OPEN_SUB = keyOf("kvfcu/open_sub@1.0.0");
const SIGN_IN = keyOf("kvfcu/sign_in@1.0.0");
const CHECKED = keyOf("kvfcu/open_sub_checked@1.0.0");
const CHECK_SUB = keyOf("kvfcu/check_sub@1.0.0");

/** Writes history lines through the real writer, so `record.json` is written too (as a command would). */
async function seed(env: ReplayEnv, key: ScoreKey, lines: HistoryLine[]): Promise<void> {
  const w = realWiringOf(env);
  for (const line of lines) {
    const r = await appendHistory(
      { scores: w.scores, locks: w.locks, artifacts: w.candidates },
      key,
      line,
      { owner: "test", command: "test", staff: "op_022" },
    );
    if (!r.ok) throw new Error(`test setup: ${r.detail ?? r.failure}`);
  }
}

const APPROVED: HistoryLine[] = [batch(1, "batch_a"), approved(2)];

/** An unattended replay of `capability`, with valid inputs and authorization. */
async function unattended(env: ReplayEnv, capability = "kvfcu/open_sub@1") {
  const inputs = writeInputs(env, { member_id: MEMBER_FOUND });
  const auth = writeAuthorization(env, capability);
  const got = await replayCall(env, ["replay", capability, "--mode", "unattended", "--inputs", inputs, "--authorization", auth, "--json"]);
  return { code: got.code, result: JSON.parse(got.stdout) as Result };
}

const rejection = (r: Result): { code: string; reason: string | undefined } | null =>
  r.status === "rejected" ? { code: r.rejection.errors[0]?.code ?? "", reason: r.rejection.errors[0]?.reason } : null;

describe("check 7 through the CLI: unattended open-share needs its session, its check, and itself approved", () => {
  test("rejected until every key is approved, then success", LONG, async () => {
    const env = await replayRoot();
    const step = async () => rejection((await unattended(env, "kvfcu/open_sub_checked@1")).result);

    expect(await step()).toEqual({ code: "context_not_approved", reason: "not_approved" });
    await seed(env, CHECKED, APPROVED);
    expect(await step()).toEqual({ code: "context_not_approved", reason: "session_not_approved" });
    await seed(env, SIGN_IN, APPROVED);
    expect(await step()).toEqual({ code: "reconciliation_not_approved", reason: "not_approved" });
    await seed(env, CHECK_SUB, APPROVED);

    const done = await unattended(env, "kvfcu/open_sub_checked@1");
    expect(done.code).toBe(EXIT.ok);
    expect(done.result.status).toBe("success");
  });

  test("demoting the task makes the next unattended run reject with degraded", LONG, async () => {
    const env = await replayRoot();
    await seed(env, OPEN_SUB, [...APPROVED, degraded(3)]);
    await seed(env, SIGN_IN, APPROVED);
    const got = await unattended(env);
    expect(got.code).toBe(EXIT.rejected);
    expect(rejection(got.result)).toEqual({ code: "context_not_approved", reason: "degraded" });
  });
});

describe("replay --pin", () => {
  const pinned = (env: ReplayEnv, pin: string, mode = "supervised", capability = "kvfcu/open_sub@1") => {
    const inputs = writeInputs(env, { member_id: MEMBER_FOUND });
    return ["replay", capability, "--mode", mode, "--inputs", inputs, "--pin", pin, "--json"];
  };

  test("an unattended pin, another major, another capability, and a patch pin are each a usage error (exit 1)", LONG, async () => {
    const env = await replayRoot();
    for (const [name, pin, mode] of [
      ["unattended mode", "kvfcu/open_sub@1.0.0", "unattended"],
      ["another major", "kvfcu/open_sub@2.0.0", "supervised"],
      ["another capability", "kvfcu/sign_in@1.0.0", "supervised"],
      ["a patch pin", "kvfcu/open_sub@1.0.0+p3", "supervised"],
    ] as [string, string, string][]) {
      const got = await replayCall(env, pinned(env, pin, mode));
      expect(got.code, name).toBe(EXIT.usage);
    }
  });

  test("a supervised pin runs, and run.json freezes the pin", LONG, async () => {
    const env = await replayRoot();
    const got = await runSupervisedToEnd(env, [...pinned(env, "kvfcu/open_sub@1.0.0"), "--authorization", writeAuthorization(env, "kvfcu/open_sub@1")]);
    expect(got.code).toBe(EXIT.ok);
    const frozen = (readRunJson(env, got.runId) as { frozen: { pin: unknown } }).frozen;
    expect(JSON.stringify(frozen.pin)).toContain("kvfcu/open_sub@1.0.0");
  });

  test("a pin reaches a retired key: the run freezes state retired", LONG, async () => {
    const env = await replayRoot();
    await seed(env, OPEN_SUB, [...APPROVED, retired(3)]);
    const got = await runSupervisedToEnd(env, [...pinned(env, "kvfcu/open_sub@1.0.0"), "--authorization", writeAuthorization(env, "kvfcu/open_sub@1")]);
    expect(got.code).toBe(EXIT.ok);
    expect(approvalOf(env, got.runId)).toMatchObject({ approval: { state: "retired" } });
  });
});

type Frozen = {
  frozen: { approval: { state: string; batch: string | null; record: string | null }; timeouts: Record<string, number>; timeouts_from: string | null };
};

/** The approval and timeout facts a run froze. */
function approvalOf(env: ReplayEnv, runId: string): Frozen["frozen"] {
  return (readRunJson(env, runId) as { frozen: Frozen }).frozen.frozen;
}

describe("what a run freezes (section 8 §11.8)", () => {
  const supervised = async (env: ReplayEnv) => {
    const inputs = writeInputs(env, { member_id: MEMBER_FOUND });
    const auth = writeAuthorization(env, "kvfcu/open_sub@1");
    return runSupervisedToEnd(env, ["replay", "kvfcu/open_sub@1", "--mode", "supervised", "--inputs", inputs, "--authorization", auth, "--json"]);
  };

  test("an approved key: its state, approving batch, record hash, and approved timeouts", LONG, async () => {
    const env = await replayRoot();
    await seed(env, OPEN_SUB, [
      batch(1, "batch_a"),
      approved(2, "op_022", "batch_a"),
      { event: "timeouts", at: "2026-01-15T09:03:00.000Z", by: "op_022", reason: "Installed.", batch: "batch_a", values: { click_search: 12000 } },
    ]);
    // Why before the run: the run writes a live line, which rebuilds the record (section 8 §5.6). The run froze the record as it was.
    const shown = await replayCall(env, ["trust", "show", "kvfcu/open_sub@1.0.0", "--json"]);
    const hash = (JSON.parse(shown.stdout) as { hash: string }).hash;
    expect(hash).toBe(hashJson((JSON.parse(shown.stdout) as { record: unknown }).record));
    const got = await supervised(env);
    expect(got.code).toBe(EXIT.ok);
    const f = approvalOf(env, got.runId);
    expect(f.approval).toMatchObject({ state: "approved" });
    expect(JSON.stringify(f.approval)).toContain("batch_a");
    expect(f.timeouts).toEqual({ click_search: 12000 });
    expect(JSON.stringify(f.timeouts_from)).toContain("batch_a");
    // The record hash is the hash of the record the resolver read.
    expect(JSON.stringify(f.approval.record)).toContain(hash);
  });

  test("no record: draft, no batch, no record hash, no timeouts", LONG, async () => {
    const env = await replayRoot();
    const got = await supervised(env);
    expect(got.code).toBe(EXIT.ok);
    expect(approvalOf(env, got.runId)).toMatchObject({
      approval: { state: "draft", batch: null, record: null },
      timeouts: {},
      timeouts_from: null,
    });
  });
});

describe("capability list and describe show the context's state", () => {
  test("approved, degraded, retired, and draft", LONG, async () => {
    const env = await replayRoot();
    await seed(env, OPEN_SUB, APPROVED);
    await seed(env, SIGN_IN, [...APPROVED, degraded(3)]);
    await seed(env, CHECK_SUB, [...APPROVED, retired(3)]);
    const list = await replayCall(env, ["capability", "list"]);
    expect(list.code).toBe(EXIT.ok);
    const line = (name: string) => list.stdout.split("\n").find((l) => l.startsWith(name)) ?? "";
    expect(line("kvfcu/open_sub@1")).toMatch(/\bapproved$/);
    expect(line("kvfcu/sign_in@1")).toMatch(/\bdegraded$/);
    expect(line("kvfcu/check_sub@1")).toMatch(/\bretired$/);
    expect(line("kvfcu/open_sub_checked@1")).toMatch(/\bdraft$/);

    const one = await replayCall(env, ["capability", "describe", "kvfcu/open_sub@1", "--json"]);
    expect((JSON.parse(one.stdout) as { state: string }).state).toBe("approved");
    const text = await replayCall(env, ["capability", "describe", "kvfcu/sign_in@1"]);
    expect(text.stdout.split("\n")[0]).toContain("degraded");
  });
});
