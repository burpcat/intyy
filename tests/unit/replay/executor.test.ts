// Proves the replay executor end to end (design section 7 §4, a run start to end; §10 the
// prelude): success with outputs, a business outcome before the commit, a rejected bad-input
// request, an unattended request, a hard failure with readable capture files, output masking
// on disk, and an uncertain commit. M05 task 8.
import { describe, expect, test } from "vitest";
import { runReplay } from "../../../src/core/replay/executor.js";
import {
  ACCOUNT_NUMBER,
  MEMBER_MISSING,
  TENANT,
  authorizationFor,
  buildHarness,
  fixtureSite,
  replayInputOf,
  requestOf,
} from "./executor-harness.js";

/** The first index whose `step` field equals `step`, or -1. */
function stepIndex(events: readonly unknown[], step: string): number {
  return events.findIndex((e) => (e as { step?: unknown }).step === step);
}

/** The event names, in order. */
function eventNames(events: readonly unknown[]): string[] {
  return events.map((e) => (e as { event: string }).event);
}

const OPEN_SUB_AUTH = authorizationFor("kvfcu/open_sub@1");

describe("runReplay: success (section 7 §4, §10)", () => {
  test("returns outputs, confirms the commit, and runs the prelude before the task's entry", async () => {
    const h = await buildHarness(fixtureSite());
    const input = replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH }));

    const { runId, result } = await runReplay(input, h.deps);

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error(`expected success, got ${result.status}`);
    expect(result.outputs).toEqual({ account_number: ACCOUNT_NUMBER });
    expect(result.effect).toMatchObject({ commit: "confirmed", performed_by: "bot" });

    const events = await h.deps.evidence.events(TENANT, runId);
    if (!events.ok) throw new Error("events failed");
    const preludeEntry = stepIndex(events.value, "session:entry");
    const preludeClick = stepIndex(events.value, "session:click_login");
    const taskEntry = stepIndex(events.value, "entry");
    const firstTaskStep = stepIndex(events.value, "type_member_id");
    expect(preludeEntry).toBeGreaterThanOrEqual(0);
    expect(preludeClick).toBeGreaterThan(preludeEntry);
    expect(taskEntry).toBeGreaterThan(preludeClick);
    expect(firstTaskStep).toBeGreaterThan(taskEntry);
  });
});

describe("runReplay: a business outcome before the commit", () => {
  test("member_not_found: business_outcome, commit not_sent (the commit was never reached)", async () => {
    const h = await buildHarness(fixtureSite({ result: "not_found" }));
    const input = replayInputOf(
      h,
      requestOf({ inputs: { member_id: MEMBER_MISSING }, authorization: OPEN_SUB_AUTH }),
    );

    const { result } = await runReplay(input, h.deps);

    expect(result.status).toBe("business_outcome");
    if (result.status !== "business_outcome") throw new Error(`expected business_outcome, got ${result.status}`);
    expect(result.outcome.code).toBe("member_not_found");
    // `member_not_found` fires on `click_search`, a step before the commit point: the commit
    // was never sent (section 3 §5.8's "not_sent": "The commit action never went out").
    expect(result.effect).toMatchObject({ commit: "not_sent", performed_by: null, sent_at: null });
  });
});

describe("runReplay: rejected requests never open the surface", () => {
  test("invalid_input: a run ID, a three-line log, run.json, and a tenant-index line", async () => {
    const h = await buildHarness(fixtureSite());
    const input = replayInputOf(h, requestOf({ inputs: {} }));

    const { runId, result } = await runReplay(input, h.deps);

    expect(result).toMatchObject({
      status: "rejected",
      rejection: { errors: [{ code: "invalid_input" }] },
    });

    const events = await h.deps.evidence.events(TENANT, runId);
    if (!events.ok) throw new Error("events failed");
    expect(eventNames(events.value)).toEqual(["run_start", "precheck", "run_end"]);
    // No gate line exists at all: the surface never opened.
    expect(events.value.some((e) => (e as { event: string }).event === "gate")).toBe(false);

    const runJson = await h.deps.evidence.readRunJson(TENANT, runId);
    expect(runJson.ok).toBe(true);
    // Two index lines: "running" at start, then the terminal "rejected" (section 3 §7.3;
    // docs/decisions.md, M03: "The tenant index gets a line at start ... and at the end").
    const index = await h.deps.evidence.index(TENANT);
    expect(index.ok && index.value.length).toBe(2);
  });

  test("unattended mode: rejected context_not_approved", async () => {
    const h = await buildHarness(fixtureSite());
    const input = replayInputOf(
      h,
      requestOf({ mode: "unattended", authorization: OPEN_SUB_AUTH }),
    );

    const { result } = await runReplay(input, h.deps);

    expect(result).toMatchObject({
      status: "rejected",
      rejection: { errors: [{ code: "context_not_approved" }] },
    });
  });
});

describe("runReplay: a hard failure", () => {
  test("a missing target ends failed, with readable capture files", async () => {
    const h = await buildHarness(fixtureSite({ homeMissingBox: true }));
    const input = replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH }));

    const { runId, result } = await runReplay(input, h.deps);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error(`expected failed, got ${result.status}`);
    expect(result.failure.code).toBe("target_not_found");
    expect(result.failure.phase).toBe("target");
    expect(result.failure.files.length).toBeGreaterThan(0);
    // The commit point (click_confirm) was never reached: not_sent (state reached).
    expect(result.effect).toMatchObject({ commit: "not_sent", performed_by: null, sent_at: null });

    const folder = await h.deps.evidence.openRun(TENANT, runId);
    if (!folder.ok) throw new Error("openRun failed");
    for (const path of result.failure.files) {
      const read = await folder.value.readFile(path);
      expect(read.ok).toBe(true);
    }
  });
});

describe("runReplay: output masking (section 3 §6.4, §6.7)", () => {
  test("raw in the in-memory result; the raw bytes never reach run.json or events.jsonl", async () => {
    const h = await buildHarness(fixtureSite());
    const input = replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH }));

    const { runId, result } = await runReplay(input, h.deps);
    if (result.status !== "success") throw new Error(`expected success, got ${result.status}`);
    expect(result.outputs.account_number).toBe(ACCOUNT_NUMBER);

    const runJson = await h.deps.evidence.readRunJson(TENANT, runId);
    if (!runJson.ok) throw new Error("readRunJson failed");
    expect(JSON.stringify(runJson.value)).not.toContain(ACCOUNT_NUMBER);

    const events = await h.deps.evidence.events(TENANT, runId);
    if (!events.ok) throw new Error("events failed");
    expect(JSON.stringify(events.value)).not.toContain(ACCOUNT_NUMBER);
  });
});

describe("runReplay: an uncertain commit", () => {
  test("neither the checkpoint nor a declared outcome passes: failed, safe_to_retry false", async () => {
    const h = await buildHarness(fixtureSite({ confirm: "stuck" }));
    const input = replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH }));

    const { result } = await runReplay(input, h.deps);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error(`expected failed, got ${result.status}`);
    expect(result.failure.safe_to_retry).toBe(false);
    expect(result.effect).toMatchObject({ commit: "uncertain", performed_by: "bot" });
  });
});
