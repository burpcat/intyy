// Proves the replay executor end to end (design section 7 §4, a run start to end; §10 the
// prelude): success with outputs, a business outcome before the commit, a rejected bad-input
// request, an unattended request, a hard failure with readable capture files, output masking
// on disk, and an uncertain commit. M05 task 8.
import { describe, expect, test } from "vitest";
import { runReplay } from "../../../src/core/replay/executor.js";
import { FakeOperator } from "../../../src/fakes/operator.js";
import type { FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
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
  test("returns outputs, confirms the commit, and runs the prelude, and skips the task's entry when the prelude already landed there", async () => {
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
    // The prelude's click lands on `/home`, the task's own entry: no second navigate (a reload
    // of a frameset shows an empty screen; docs/decisions.md, M05).
    expect(taskEntry).toBe(-1);
    expect(firstTaskStep).toBeGreaterThan(preludeClick);
  });

  test("when the prelude ends somewhere else, the task's entry navigate still runs", async () => {
    // Login lands on `/home?from=login`: the task's entry `/home` has the same path but a
    // different query, so it is a different place and must be navigated to.
    const base = fixtureSite();
    const site: FakeSite = {
      ...base,
      screens: {
        ...base.screens,
        "/": {
          elements: [
            { id: "login_button", role: "button", roleGroup: "button_like", name: "Login", text: "Login", onClick: { go: "/home?from=login" } },
          ],
        },
      },
    };
    const h = await buildHarness(site);
    const { runId, result } = await runReplay(replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH })), h.deps);

    expect(result.status).toBe("success");
    const events = await h.deps.evidence.events(TENANT, runId);
    if (!events.ok) throw new Error("events failed");
    const preludeClick = stepIndex(events.value, "session:click_login");
    const taskEntry = stepIndex(events.value, "entry");
    expect(taskEntry).toBeGreaterThan(preludeClick);
    expect(stepIndex(events.value, "type_member_id")).toBeGreaterThan(taskEntry);
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

describe("runReplay: a known screen with no progress, on a location-only precondition (docs/decisions.md, M06)", () => {
  test("a missing target on a bare-location precondition climbs to a takeover, not a hard failure", async () => {
    // `type_member_id`'s precondition, `home_shown`, is a bare `location` check (open_sub.json):
    // M06's rule says that never counts as "a known screen" at rung 1 step 5, so retries used
    // up here climb instead of failing (section 5 §8.4 step 5; docs/decisions.md, M06). Rungs 2
    // and 3 are off, so the climb goes straight to rung 4; with nothing scripted, the fake
    // operator's own fallback ends the run (section 9 §5.9).
    const operator = new FakeOperator([]);
    const h = await buildHarness(fixtureSite({ homeMissingBox: true }), { operator: () => operator });
    const input = replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH }));

    const { result } = await runReplay(input, h.deps);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error(`expected failed, got ${result.status}`);
    expect(result.failure.code).toBe("ended_by_operator");
    expect(result.failure.ladder).toEqual({ rung: 4, verdict: "needs_human", ref: "takeover" });
    // The commit point (click_confirm) was never reached: not_sent (state reached).
    expect(result.effect).toMatchObject({ commit: "not_sent", performed_by: null, sent_at: null });

    // The takeover request itself, with the M06 fields (section 7 §13.1): the supervised
    // mode's own start confirmation is the first mailbox interaction (docs/decisions.md, M05);
    // the takeover this test is about is the second.
    expect(operator.requests).toHaveLength(2);
    expect(operator.requests[1]).toMatchObject({
      kind: "takeover",
      reason: "stuck",
      step: { id: "type_member_id" },
      trouble: { phase: "target" },
      commit: { state: "not_sent", notice: null },
      operator_note: null,
      decisions: ["end_run"],
    });
    const ladder = (operator.requests[1] as unknown as { ladder: unknown[] }).ladder;
    expect(ladder.length).toBeGreaterThan(0);
  });
});

describe("runReplay: a hard failure", () => {
  test("a missing target on a non-location precondition still ends target_not_found, with readable capture files", async () => {
    // `click_search`'s own precondition, `member_id_entered`, is a `field_value` check: M06's
    // location-only carve-out does not apply, so retries used up here still end the underlying
    // failure, not a climb (section 5 §8.4 step 5; docs/decisions.md, M06).
    const h = await buildHarness(fixtureSite({ homeMissingSearchButton: true }));
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

describe("runReplay: an uncertain commit (section 5 §2.6: never end on uncertain while a check can run)", () => {
  test("open_sub has no reconciliation check: a human's not_found, then no_retry, ends failed/action_failed, safe_to_retry true, absent_by_check", async () => {
    // No `recovery.reconciliation.check` on `open_sub.json`: `runReconciliationCheck` answers
    // `unclear` at once (section 7 §11.1's own fallback), so this goes straight to a human
    // reconciliation decision. With nothing scripted, the fake operator's own fallback answers
    // `not_found` (docs/decisions.md, M06), then `no_retry` for the retry decision that follows
    // (section 7 §11.3 point 3: "the parent ends `failed`, commit `absent_by_check`,
    // `safe_to_retry: true`").
    const h = await buildHarness(fixtureSite({ confirm: "stuck" }));
    const input = replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH }));

    const { result } = await runReplay(input, h.deps);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error(`expected failed, got ${result.status}`);
    expect(result.failure.code).toBe("action_failed");
    expect(result.failure.safe_to_retry).toBe(true);
    expect(result.effect).toMatchObject({ commit: "absent_by_check", performed_by: "bot" });
  });

  test("no human answers the reconciliation decision: the commit stays uncertain, safe_to_retry false, escalation_timeout (section 3 §5.12, the worst case)", async () => {
    // One shared operator instance answers the run's own start confirmation (the first mailbox
    // interaction, docs/decisions.md M05), then stays silent on the reconciliation decision that
    // follows, until its own deadline (section 7 §13.3's table: "Reconciliation decision
    // unanswered: `failed`, `escalation_timeout`, commit `uncertain`").
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, "silent"]);
    const h = await buildHarness(fixtureSite({ confirm: "stuck" }), { operator: () => operator });
    const input = replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH }));

    const { result } = await runReplay(input, h.deps);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error(`expected failed, got ${result.status}`);
    expect(result.failure.code).toBe("escalation_timeout");
    expect(result.failure.safe_to_retry).toBe(false);
    expect(result.effect).toMatchObject({ commit: "uncertain", performed_by: "bot" });
  });
});
