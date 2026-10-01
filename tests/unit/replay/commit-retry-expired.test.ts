// Proves a commit retry whose authorization expired during the human wait (design section 7 §11.3:
// "The authorization is checked again. Expired: approval at the commit point."; section 3 §4.6 and
// §4.8 check 8). The retry child is not rejected for expiry: it reaches the commit point, the gate
// asks a person, and the person's approval lets it commit. A retry child rejected for any other
// reason ends the parent `failed` (code `action_failed`, phase `start`, safe to retry) and keeps the
// parent's effect; nothing is retried on its own. Synthetic values only.
import { describe, expect, test } from "vitest";
import { runReplay } from "../../../src/core/replay/executor.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { FakeOperator } from "../../../src/fakes/operator.js";
import type { FakeElement, FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { ORIGIN, TENANT, authorizationFor, buildHarness, replayInputOf, requestOf } from "./executor-harness.js";

const LOGIN: FakeElement = { id: "login_button", role: "button", roleGroup: "button_like", name: "Login", text: "Login", onClick: { go: "/home" } };
const MEMBER_ID_BOX: FakeElement = { id: "member_id_box", role: "textbox", roleGroup: "text_entry", label: "Member ID", field: { kind: "text", value: "" } };
const SEARCH: FakeElement = { id: "search_button", role: "button", roleGroup: "button_like", name: "Search", text: "Search", onClick: { go: "/result" } };
const CONFIRM_STUCK: FakeElement = { id: "confirm_button", role: "button", roleGroup: "button_like", name: "Confirm", text: "Confirm" };
const CONFIRM_WORKS: FakeElement = { ...CONFIRM_STUCK, onClick: { go: "/done" } };
const ACCOUNT: FakeElement = { id: "account_number_display", role: "generic", roleGroup: "container", label: "Account number", text: "SH7777777" };
/** The check page when no sub-account exists: the read target holds text, and the not-found text shows. */
const CHECK_ABSENT: FakeElement[] = [
  { ...ACCOUNT, text: "N/A" },
  { id: "not_found_msg", role: "generic", roleGroup: "container", text: "No sub-account found" },
];

/**
 * Confirm is lost until the check page has been read once; after that it works. `onCheck` runs on
 * each load of `/check`, so a test can change the world while the person is still deciding: the
 * check runs just before the retry decision. (The operator script cannot do this: a scripted step
 * that waits makes the fake clock's deadline win the race.)
 */
function siteLostThenWorks(onCheck: () => void = () => undefined): FakeSite {
  let checked = false;
  return {
    origin: ORIGIN,
    screens: {
      "/": { elements: [LOGIN] },
      "/home": { elements: [MEMBER_ID_BOX, SEARCH] },
      get "/result"() {
        return { elements: [checked ? CONFIRM_WORKS : CONFIRM_STUCK] };
      },
      "/done": { elements: [ACCOUNT] },
      get "/check"() {
        checked = true;
        onCheck();
        return { elements: CHECK_ABSENT };
      },
    },
  };
}

const CAP = "kvfcu/open_sub_checked@1";
type Harness = Awaited<ReturnType<typeof buildHarness>>;
type Line = { event: string; data: Record<string, unknown> };

/** The default authorization (09:50 to 10:20 in spirit: 30 minutes, so it ends soon after the fake clock's start). */
const shortInput = (h: Harness) => replayInputOf(h, requestOf({ authorization: authorizationFor(CAP), capability: CAP }));

/** A long-lived authorization, so no fake wait can expire it (as the other reconciliation tests do). */
const longInput = (h: Harness) => ({
  ...shortInput(h),
  request: requestOf({
    authorization: { ...authorizationFor(CAP), granted_at: "2026-01-16T08:50:00.000Z", expires_at: "2026-01-16T09:00:00.000Z" },
    capability: CAP,
  }),
});

async function linesOf(h: Harness, runId: string): Promise<Line[]> {
  const e = await h.deps.evidence.events(TENANT, runId);
  if (!e.ok) throw new Error("events missing");
  return e.value as Line[];
}

/** The lines of the first run whose `run_start` line has the given purpose. */
async function linesOfPurpose(h: Harness, purpose: string): Promise<Line[] | undefined> {
  for (const id of await h.deps.evidence.listRuns(TENANT)) {
    const lines = await linesOf(h, id);
    if (lines.find((l) => l.event === "run_start")?.data.purpose === purpose) return lines;
  }
  return undefined;
}

/** The gate's decisions on the irreversible click, in order. */
function commitGates(lines: Line[] | undefined): unknown[] {
  return (lines ?? []).filter((l) => l.event === "gate" && l.data.risk === "irreversible").map((l) => l.data.decision);
}

/** A harness whose fake clock jumps `minutes` forward when the check page loads: the person is slow. */
async function slowPerson(operator: FakeOperator, minutes: number): Promise<Harness> {
  // Why `const` is safe: the callback runs only after `buildHarness` has returned.
  const h: Harness = await buildHarness(
    siteLostThenWorks(() => {
      if (h.deps.clock instanceof SteppingClock) h.deps.clock.advance(minutes * 60_000);
    }),
    { operator: () => operator },
  );
  return h;
}

describe("a commit retry after the authorization expired (section 7 §11.3)", () => {
  test("the retry is not rejected: it asks for approval at the commit point, the person approves, and the retry commits", async () => {
    const operator = new FakeOperator([
      { staff: "op_017", decision: "approved" }, // the start confirmation
      { staff: "op_017", decision: "retry" },
      { staff: "op_017", decision: "approved" }, // the commit-point approval of the retry
    ]);
    // 40 minutes pass before the retry starts: the 30-minute authorization ended long before.
    const h = await slowPerson(operator, 40);
    const { runId, result } = await runReplay(shortInput(h), h.deps);

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.outputs).toEqual({ account_number: "SH7777777" });
    expect(result.effect?.attempts).toEqual([{ run_id: runId, commit: "absent_by_check" }]);

    // The retry child was not rejected, and its commit waited for a person: start confirmation,
    // retry decision, then an approval request, in that order, and nothing else.
    expect(operator.requests.map((r) => r.kind)).toEqual(["start_confirmation", "retry_decision", "approval"]);
    const lines = await linesOfPurpose(h, "commit_retry");
    expect(lines).toBeDefined();
    // Check 8 let the expired authorization through, and the gate did not call it valid.
    expect(lines?.find((l) => l.event === "precheck")?.data).toBeDefined();
    expect(JSON.stringify(lines?.find((l) => l.event === "precheck")?.data)).not.toContain('"passed":false');
    expect(commitGates(lines)).toEqual(["needs_approval", "allowed"]);
  });

  test("the person declines the commit-point approval: the retry sends nothing, and the parent does not end success", async () => {
    const operator = new FakeOperator([
      { staff: "op_017", decision: "approved" },
      { staff: "op_017", decision: "retry" },
      { staff: "op_017", decision: "declined" },
    ]);
    const h = await slowPerson(operator, 40);
    const { result } = await runReplay(shortInput(h), h.deps);

    expect(operator.requests.map((r) => r.kind)).toEqual(["start_confirmation", "retry_decision", "approval"]);
    expect(result.status).not.toBe("success");
    const lines = await linesOfPurpose(h, "commit_retry");
    expect(commitGates(lines)).toEqual(["needs_approval"]);
    expect(lines?.some((l) => l.event === "commit_intent")).toBe(false);
  });

  test("a retry whose authorization has not expired commits with no approval (the unchanged path)", async () => {
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "retry" }]);
    const h = await buildHarness(siteLostThenWorks(), { operator: () => operator });
    const { result } = await runReplay(longInput(h), h.deps);

    expect(result.status).toBe("success");
    expect(operator.requests.map((r) => r.kind)).toEqual(["start_confirmation", "retry_decision"]);
    const lines = await linesOfPurpose(h, "commit_retry");
    expect(commitGates(lines)).toEqual(["allowed"]);
  });
});

describe("a retry child rejected for another reason (section 7 §11.3; section 3 §5.6)", () => {
  test("the parent ends failed, action_failed, phase start, safe to retry, keeping its effect; nothing is retried on its own", async () => {
    const operator = new FakeOperator([
      { staff: "op_017", decision: "approved" },
      { staff: "op_017", decision: "retry" },
      { staff: "op_017", decision: "approved" },
    ]);
    // While the person decides, the tenant stops listing the capability (check 9 then rejects the retry).
    const h: Harness = await buildHarness(
      siteLostThenWorks(() => {
        h.policy.effective.capabilities.allow.splice(0);
      }),
      { operator: () => operator },
    );
    const { result } = await runReplay(longInput(h), h.deps);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failure).toMatchObject({ code: "action_failed", phase: "start", safe_to_retry: true });
    expect(result.failure.message).toContain("policy_denied");
    // The parent keeps what it knows: the first commit was found absent by the check.
    expect(result.effect).toMatchObject({ commit: "absent_by_check", check: { decided_by: "code" } });

    // No automatic second try: the person saw the start and the retry decision, and nothing after.
    expect(operator.requests.map((r) => r.kind)).toEqual(["start_confirmation", "retry_decision"]);
    // The rejected retry sent nothing: no run holds a second commit_intent.
    let intents = 0;
    for (const id of await h.deps.evidence.listRuns(TENANT)) {
      intents += (await linesOf(h, id)).filter((l) => l.event === "commit_intent").length;
    }
    expect(intents).toBe(1);
  });
});
