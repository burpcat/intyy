// Proves reconciliation runs end to end, through `runReplay` (design section 7 §11; section 5
// §2.6, "never end on uncertain while a check can run"; section 3 §5.8; docs/decisions.md M06).
// `open_sub_checked.json` links a real check capability, `check_sub.json`, so these tests run a
// genuine child run, not a scripted `reconciliationCheck` hook. M06 task 5.
import { describe, expect, test } from "vitest";
import { runReplay } from "../../../src/core/replay/executor.js";
import { Artifact as ArtifactSchema } from "../../../src/core/model/artifact.js";
import type { FrozenSet } from "../../../src/core/packs/merge.js";
import type { Handler } from "../../../src/core/model/pack.js";
import { sha256Hex } from "../../../src/core/model/canonical.js";
import { FakeOperator } from "../../../src/fakes/operator.js";
import { snapshotFactory, type FakeElement, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { fromFactory, toFactory, type Hands } from "../../../src/ports/hands.js";
import type { SurfaceFactory } from "../../../src/ports/surface.js";
import {
  ORIGIN,
  TENANT,
  authorizationFor,
  buildHarness,
  OPEN_SUB_CHECKED,
  replayInputOf,
  requestOf,
} from "./executor-harness.js";

const LOGIN: FakeElement = { id: "login_button", role: "button", roleGroup: "button_like", name: "Login", text: "Login", onClick: { go: "/home" } };
const MEMBER_ID_BOX: FakeElement = { id: "member_id_box", role: "textbox", roleGroup: "text_entry", label: "Member ID", field: { kind: "text", value: "" } };
const SEARCH: FakeElement = { id: "search_button", role: "button", roleGroup: "button_like", name: "Search", text: "Search", onClick: { go: "/result" } };
/** Confirm's click goes nowhere: the checkpoint (`/done`) never comes, so the commit ends
 * `uncertain` (section 2 §16.6) — the same shape as `drop_after_confirm` (CONTRACT.md §6: the
 * reply to Confirm is lost after the commit took effect). */
const CONFIRM_STUCK: FakeElement = { id: "confirm_button", role: "button", roleGroup: "button_like", name: "Confirm", text: "Confirm" };

/** `account_number_display` always exists (a real read target either way); `check_sub`'s own
 * declared outcome, not a missing target, is what tells "found" from "not found" apart
 * (section 7 §11.1; section 5 §8.1, "declared outcomes race the checkpoint"). */
function checkScreen(result: "found" | "absent", accountNumber: string): FakeElement[] {
  // The read target must hold a non-empty value even when absent (an empty string converts to
  // no value at all, `output_parse_failed`, section 6 §9.3): the declared outcome, not a
  // failed read, is what tells "found" from "not found" apart here.
  const display: FakeElement = {
    id: "account_number_display",
    role: "generic",
    roleGroup: "container",
    label: "Account number",
    text: result === "found" ? accountNumber : "N/A",
  };
  if (result === "found") return [display];
  return [display, { id: "not_found_msg", role: "generic", roleGroup: "container", text: "No sub-account found" }];
}

/** The `open_sub_checked` flow, stuck on Confirm, with `/check` answering `checkResult`. */
function siteChecked(checkResult: "found" | "absent", accountNumber = "SH9999999"): FakeSite {
  return {
    origin: ORIGIN,
    screens: {
      "/": { elements: [LOGIN] },
      "/home": { elements: [MEMBER_ID_BOX, SEARCH] },
      "/result": { elements: [CONFIRM_STUCK] },
      "/done": { elements: [] },
      "/check": { elements: checkScreen(checkResult, accountNumber) },
    },
  };
}

/** A stateful `/check`: the first read answers `first`, every later one `then` (case 4, section
 * 7 §11.3: the retry's own child asks the check again). */
function siteCheckedTwice(first: "found" | "absent", then: "found" | "absent"): FakeSite {
  let checkVisits = 0;
  return {
    origin: ORIGIN,
    screens: {
      "/": { elements: [LOGIN] },
      "/home": { elements: [MEMBER_ID_BOX, SEARCH] },
      "/result": { elements: [CONFIRM_STUCK] },
      "/done": { elements: [] },
      get "/check"() {
        checkVisits += 1;
        return { elements: checkScreen(checkVisits === 1 ? first : then, "SH9999999") };
      },
    },
  };
}

/** A run authorized against `open_sub_checked`, supervised (the default), so the parent's own
 * start confirmation is the first mailbox interaction (docs/decisions.md, M05). */
function inputFor(h: Awaited<ReturnType<typeof buildHarness>>, capability = "kvfcu/open_sub_checked@1") {
  return replayInputOf(h, requestOf({ authorization: authorizationFor(capability), capability }));
}

/** A one-handler frozen set: a global `needs_human` handler on a supervisor banner's text
 * (mirrors `takeover.test.ts`'s own scenario). */
function frozenSetWith(handler: Handler, conditionText: string, conditionId: string): FrozenSet {
  return {
    targets: [],
    conditions: [{ id: conditionId, description: conditionId, check: "text_visible", text: conditionText, match: "contains" }],
    handlers: [handler],
    handlerScope: new Map([[handler.id, { level: "global" as const }]]),
    runStart: { ids: [handler.id], packs: { global: 1 }, from: { [handler.id]: "global" }, hash: `sha256:${sha256Hex(handler.id)}` },
    warnings: [],
  };
}

const SUPERVISOR_HANDLER: Handler = {
  class: "needs_human",
  id: "supervisor_required",
  description: "a supervisor must approve this",
  detector: "supervisor_banner_shown",
  fixtures: { fire: [], no_fire: [] },
  operator_note: "A supervisor must approve this transfer.",
};
const SUPERVISOR_FROZEN_SET = frozenSetWith(SUPERVISOR_HANDLER, "Ask a supervisor to approve this", "supervisor_banner_shown");

/** Confirm inserts a banner, with no navigation: still stuck, but the `needs_human` handler
 * above now matches the post-commit screen (section 7 §13.1's own in-flight takeover). */
function siteWithBanner(checkResult: "found" | "absent"): FakeSite {
  return {
    origin: ORIGIN,
    screens: {
      "/": { elements: [LOGIN] },
      "/home": { elements: [MEMBER_ID_BOX, SEARCH] },
      "/result": {
        elements: [
          {
            ...CONFIRM_STUCK,
            onClick: { insert: { id: "supervisor_banner", role: "generic", roleGroup: "container", text: "Ask a supervisor to approve this" } },
          },
        ],
      },
      "/done": { elements: [] },
      "/check": { elements: checkScreen(checkResult, "SH9999999") },
    },
  };
}

describe("case 1: found (section 7 §11.1)", () => {
  test("success, outputs mapped via {result.*}, effect.commit found_by_check, decided_by code; the child run is kind reconciliation, with parent_run_id, and asks no start confirmation", async () => {
    const h = await buildHarness(siteChecked("found", "SH9999999"));
    const { runId, result } = await runReplay(inputFor(h), h.deps);

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.outputs).toEqual({ account_number: "SH9999999" });
    expect(result.effect).toMatchObject({ commit: "found_by_check", check: { decided_by: "code", staff_id: null } });

    const childRunId = result.effect?.check?.run_id;
    if (typeof childRunId !== "string") throw new Error("no child run id recorded");
    const childRun = await h.deps.evidence.readRunJson(TENANT, childRunId);
    if (!childRun.ok) throw new Error("child run.json missing");
    expect(childRun.value).toMatchObject({ kind: "reconciliation", parent_run_id: runId });

    const childEvents = await h.deps.evidence.events(TENANT, childRunId);
    if (!childEvents.ok) throw new Error("child events missing");
    expect(childEvents.value.some((e) => (e as { data?: { kind?: string } }).data?.kind === "start_confirmation")).toBe(false);
  });
});

describe("case 2: found, but outputs unreadable (section 7 §11.1)", () => {
  test("failed, outputs_unavailable, commit found_by_check, safe_to_retry false", async () => {
    const h = await buildHarness(siteChecked("found", "SH9999999"));
    // A separate capability whose own check-outputs map points at a child output name
    // `check_sub` never produces: "found, but outputs missing" (section 7 §11.1).
    const badMap = ArtifactSchema.parse({
      ...OPEN_SUB_CHECKED,
      identity: { ...OPEN_SUB_CHECKED.identity, capability: "open_sub_badmap" },
      recovery: {
        commit_point: "click_confirm",
        reconciliation: {
          check: {
            capability: "kvfcu/check_sub@1",
            inputs: { member_id: "{input.member_id}" },
            not_found_outcomes: ["sub_not_found"],
            outputs: { account_number: "{result.nonexistent}" },
          },
        },
      },
    });
    const sealed = await h.deps.artifacts.seal("kvfcu/open_sub_badmap/cand_2026-01-15_1000000005", "1.0.0", "op_017", badMap, {});
    if (!sealed.ok) throw new Error("test setup: badMap seal failed");

    const { result } = await runReplay(inputFor(h, "kvfcu/open_sub_badmap@1"), h.deps);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failure.code).toBe("outputs_unavailable");
    expect(result.failure.safe_to_retry).toBe(false);
    expect(result.effect).toMatchObject({ commit: "found_by_check" });
  });
});

describe("case 3: absent, no retry (section 7 §11.3)", () => {
  test("failed, safe_to_retry true, absent_by_check", async () => {
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "no_retry" }]);
    const h = await buildHarness(siteChecked("absent"), { operator: () => operator });
    const { result } = await runReplay(inputFor(h), h.deps);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failure.code).toBe("action_failed");
    expect(result.failure.safe_to_retry).toBe(true);
    expect(result.effect).toMatchObject({ commit: "absent_by_check", check: { decided_by: "code" } });
  });
});

describe("case 4: absent, retry (section 7 §11.3)", () => {
  test("a new child run answers the retry; a second absent on it ends without another ask", async () => {
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "retry" }]);
    const h = await buildHarness(siteCheckedTwice("absent", "absent"), { operator: () => operator });
    // A long-lived authorization: the fake clock's own deadline waits (section 7 §13.3) each
    // advance it at once, and the retry child re-checks authorization at its own commit point
    // (section 7 §11.3, "the authorization is checked again"); the default fixture window
    // (20 minutes) would otherwise expire before the retry child ever gets there.
    const input = {
      ...inputFor(h),
      request: requestOf({
        authorization: {
          ...authorizationFor("kvfcu/open_sub_checked@1"),
          granted_at: "2026-01-16T08:50:00.000Z",
          expires_at: "2026-01-16T09:00:00.000Z",
        },
        capability: "kvfcu/open_sub_checked@1",
      }),
    };
    const { runId, result } = await runReplay(input, h.deps);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failure.code).toBe("action_failed");
    expect(result.failure.safe_to_retry).toBe(true);
    expect(result.effect).toMatchObject({ commit: "absent_by_check" });
    expect(result.effect?.attempts).toEqual([{ run_id: runId, commit: "absent_by_check" }]);
    // No third mailbox interaction: only the confirmation and the one retry decision.
    expect(operator.requests).toHaveLength(2);
  });
});

describe("case 6: a takeover ended while the commit is in flight (docs/decisions.md, M06)", () => {
  test("found: one check, then the takeover's own ended_by_operator stands, with the commit state the check found", async () => {
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "end_run" }]);
    const h = await buildHarness(siteWithBanner("found"), { operator: () => operator });
    const { result } = await runReplay({ ...inputFor(h), frozenSet: SUPERVISOR_FROZEN_SET }, h.deps);

    // "No retry is offered. The run ends failed, ended_by_operator, with the commit state the
    // check found" (docs/decisions.md, M06): unlike the ordinary uncertain-commit path, a
    // decisive "found" here never turns into `success` — the takeover's own ending stands.
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failure.code).toBe("ended_by_operator");
    expect(result.effect).toMatchObject({ commit: "found_by_check" });
    expect(operator.requests).toHaveLength(2);
  });

  test("absent: one check, no retry_decision request opens, ended_by_operator, absent_by_check", async () => {
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "end_run" }]);
    const h = await buildHarness(siteWithBanner("absent"), { operator: () => operator });
    const { result } = await runReplay({ ...inputFor(h), frozenSet: SUPERVISOR_FROZEN_SET }, h.deps);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failure.code).toBe("ended_by_operator");
    expect(result.effect).toMatchObject({ commit: "absent_by_check" });
    // Only the start confirmation and the takeover itself: no retry_decision follows here
    // (docs/decisions.md, M06: "No retry is offered").
    expect(operator.requests).toHaveLength(2);
    expect(operator.requests.some((r) => r.kind === "retry_decision")).toBe(false);
  });
});

describe("the M06 gate row: drop_after_confirm ends success, found_by_check, through a child run", () => {
  test("the reply to Confirm is lost after the commit took effect; the check finds it", async () => {
    const h = await buildHarness(siteChecked("found", "SH9999999"));
    const { result } = await runReplay(inputFor(h), h.deps);

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.effect).toMatchObject({ commit: "found_by_check", check: { decided_by: "code" } });
  });
});

/** `open_sub_checked` with a waiver in place of the check (section 2 §16.3). Sealed per test. */
const OPEN_SUB_WAIVED = ArtifactSchema.parse({
  ...OPEN_SUB_CHECKED,
  identity: { ...OPEN_SUB_CHECKED.identity, capability: "open_sub_waived" },
  recovery: { commit_point: "click_confirm", reconciliation: { waiver: { reason: "The app shows no screen to check.", attempt_run: "run_2026-10-01_0123456789" } } },
});

/** Every `escalation` log line of run `runId`, as loose objects. */
async function escalationLines(h: Awaited<ReturnType<typeof buildHarness>>, runId: string): Promise<{ data: { kind?: string; reason?: string } }[]> {
  const events = await h.deps.evidence.events(TENANT, runId);
  if (!events.ok) throw new Error("events missing");
  return events.value.filter((e) => (e as { event?: string }).event === "escalation") as { data: { kind?: string; reason?: string } }[];
}

describe("the reconciliation_decision reason (section 3 §5.7; docs/decisions.md, M06)", () => {
  test("a waiver: the log lines and the mailbox request carry reconciliation_waived", async () => {
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "not_found" }]);
    const h = await buildHarness(siteChecked("absent"), { operator: () => operator });
    const sealed = await h.deps.artifacts.seal("kvfcu/open_sub_waived/cand_2026-01-15_1000000006", "1.0.0", "op_017", OPEN_SUB_WAIVED, {});
    if (!sealed.ok) throw new Error("test setup: waived seal failed");

    const { runId } = await runReplay(inputFor(h, "kvfcu/open_sub_waived@1"), h.deps);

    const recon = (await escalationLines(h, runId)).filter((l) => l.data.kind === "reconciliation_decision");
    expect(recon.length).toBeGreaterThanOrEqual(2);
    expect(recon.every((l) => l.data.reason === "reconciliation_waived")).toBe(true);
    expect(operator.requests[1]).toMatchObject({ kind: "reconciliation_decision", reason: "reconciliation_waived" });
  });

  test("a check with an unclear result: reconciliation_unclear, in the log lines and the request", async () => {
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "not_found" }]);
    const h = await buildHarness(siteChecked("absent"), {
      operator: () => operator,
      reconciliationCheck: () => Promise.resolve({ kind: "unclear" }),
    });

    const { runId } = await runReplay(inputFor(h), h.deps);

    const recon = (await escalationLines(h, runId)).filter((l) => l.data.kind === "reconciliation_decision");
    expect(recon.length).toBeGreaterThanOrEqual(2);
    expect(recon.every((l) => l.data.reason === "reconciliation_unclear")).toBe(true);
    expect(operator.requests[1]).toMatchObject({ kind: "reconciliation_decision", reason: "reconciliation_unclear" });
  });
});

/**
 * A surface whose first session loses the reply to its `n`-th click: the click still lands, but
 * the answer is `dispatched: "unknown"` with `transport: "connection_closed"`, which is how the
 * bank's `hang` fault reaches the hands (CONTRACT.md §6: no reply for 45 s, then the connection
 * closes; section 7 §7.3). Later sessions (the check children) are untouched. `lost` counts the
 * lost replies, `clicks` the clicks the first session sent.
 */
function hangOnClick(site: FakeSite, n: number): { surface: SurfaceFactory; lost: () => number; clicks: () => number } {
  const inner = fromFactory(snapshotFactory(site));
  let opens = 0;
  let clicks = 0;
  let lost = 0;
  const surface = toFactory({
    async open(cfg, signal) {
      const first = opens === 0;
      opens += 1;
      const got = await inner.open(cfg, signal);
      if (!first || !got.ok) return got;
      const hands: Hands = {
        async act(a, lease, sig) {
          const r = await got.value.hands.act(a, lease, sig);
          if (a.type !== "click" || !r.ok) return r;
          clicks += 1;
          if (clicks !== n) return r;
          lost += 1;
          return { ...r, value: { dispatched: "unknown", transport: "connection_closed" } };
        },
      };
      return { ...got, value: { ...got.value, hands } };
    },
    close: () => inner.close(),
  });
  return { surface, lost: () => lost, clicks: () => clicks };
}

/** Reads a run's `run_start` log line data. */
async function runStartOf(
  h: Awaited<ReturnType<typeof buildHarness>>,
  runId: string,
): Promise<{ kind?: string; purpose?: string | null; parent_run_id?: string | null }> {
  const events = await h.deps.evidence.events(TENANT, runId);
  if (!events.ok) throw new Error("events missing");
  const start = (events.value as { event?: string; data?: object }[]).find((e) => e.event === "run_start");
  if (start?.data === undefined) throw new Error("no run_start line");
  return start.data;
}

describe("the M06 gate row: a hang right after Confirm reconciles (section 5 §14; section 7 §7.3, §11)", () => {
  test("the reply to Confirm is lost to a closed connection; Confirm is not clicked again, and a child check finds the change", async () => {
    // Clicks of the parent session: login (1), Search (2), Confirm (3).
    const hang = hangOnClick(siteChecked("found", "SH9999999"), 3);
    const h = await buildHarness(siteChecked("found", "SH9999999"), { surface: hang.surface });
    const { runId, result } = await runReplay(inputFor(h), h.deps);

    expect(hang.lost()).toBe(1);
    // Never retry an irreversible step (CLAUDE.md): the hang does not send a second Confirm.
    expect(hang.clicks()).toBe(3);
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.outputs).toEqual({ account_number: "SH9999999" });
    expect(result.effect).toMatchObject({ commit: "found_by_check", check: { decided_by: "code", staff_id: null } });

    const childRunId = result.effect?.check?.run_id;
    if (typeof childRunId !== "string") throw new Error("no child run id recorded");
    expect(childRunId).not.toBe(runId);
    const childRun = await h.deps.evidence.readRunJson(TENANT, childRunId);
    if (!childRun.ok) throw new Error("child run.json missing");
    expect(childRun.value).toMatchObject({ kind: "reconciliation", parent_run_id: runId });
    expect(await runStartOf(h, childRunId)).toMatchObject({ kind: "reconciliation", purpose: "commit_check", parent_run_id: runId });
  });
});

describe("the M06 gate row: a commit retry is a new child run with a new run ID (section 7 §11.3)", () => {
  test("absent_by_check, then retry: the retry has its own ID, kind replay, purpose commit_retry, and the parent as parent", async () => {
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "retry" }]);
    const h = await buildHarness(siteCheckedTwice("absent", "absent"), { operator: () => operator });
    // A long-lived authorization, for the same reason as case 4 above.
    const input = {
      ...inputFor(h),
      request: requestOf({
        authorization: { ...authorizationFor("kvfcu/open_sub_checked@1"), granted_at: "2026-01-16T08:50:00.000Z", expires_at: "2026-01-16T09:00:00.000Z" },
        capability: "kvfcu/open_sub_checked@1",
      }),
    };
    const { runId, result } = await runReplay(input, h.deps);
    expect(result.effect?.attempts).toEqual([{ run_id: runId, commit: "absent_by_check" }]);

    // Parent, its check, the retry, and the retry's own check: four runs, four distinct IDs.
    const ids = await h.deps.evidence.listRuns(TENANT);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    const starts = await Promise.all(ids.map(async (id) => ({ id, ...(await runStartOf(h, id)) })));
    const checkChild = starts.find((s) => s.kind === "reconciliation" && s.parent_run_id === runId);
    const retryChild = starts.find((s) => s.purpose === "commit_retry");
    if (checkChild === undefined || retryChild === undefined) throw new Error("expected a check child and a retry child");
    expect(retryChild).toMatchObject({ kind: "replay", purpose: "commit_retry", parent_run_id: runId });
    expect(retryChild.id).not.toBe(runId);
    expect(retryChild.id).not.toBe(checkChild.id);
    // The retry's own check hangs off the retry, not the original parent.
    expect(starts.filter((s) => s.kind === "reconciliation" && s.parent_run_id === retryChild.id)).toHaveLength(1);
    // The retry asks for no second start confirmation or retry decision.
    expect(operator.requests).toHaveLength(2);
  });
});
