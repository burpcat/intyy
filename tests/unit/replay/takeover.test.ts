// Proves rung 4's takeover, through `runReplay`, when the commit went `uncertain` (design
// section 5 §8.9, §8.11; section 7 §13.1 to §13.3; docs/decisions.md M06, "a takeover ended
// while the commit is in flight first runs the reconciliation check"). M06 task 4.
import { describe, expect, test } from "vitest";
import { runReplay } from "../../../src/core/replay/executor.js";
import type { Handler } from "../../../src/core/model/pack.js";
import type { FrozenSet } from "../../../src/core/packs/merge.js";
import { sha256Hex } from "../../../src/core/model/canonical.js";
import { FakeOperator } from "../../../src/fakes/operator.js";
import type { FakeElement, FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { ORIGIN, TENANT, authorizationFor, buildHarness, replayInputOf, requestOf } from "./executor-harness.js";

const OPEN_SUB_AUTH = authorizationFor("kvfcu/open_sub@1");

const LOGIN: FakeElement = { id: "login_button", role: "button", roleGroup: "button_like", name: "Login", text: "Login", onClick: { go: "/home" } };
const MEMBER_ID_BOX: FakeElement = { id: "member_id_box", role: "textbox", roleGroup: "text_entry", label: "Member ID", field: { kind: "text", value: "" } };
const SEARCH: FakeElement = { id: "search_button", role: "button", roleGroup: "button_like", name: "Search", text: "Search", onClick: { go: "/result" } };
/** Confirm sends nothing new to the app: it only inserts a banner into the live page, with no
 * navigation (section 5 §14, `supervisor_required`-like). The click still "acts" (dispatched),
 * but the checkpoint (`/done`) never comes, so the race times out: `uncertain` (section 2 §16.6). */
const CONFIRM_STUCK: FakeElement = {
  id: "confirm_button",
  role: "button",
  roleGroup: "button_like",
  name: "Confirm",
  text: "Confirm",
  onClick: { insert: { id: "supervisor_banner", role: "generic", roleGroup: "container", text: "Ask a supervisor to approve this" } },
};

/** The `open_sub` flow up to a stuck Confirm on `/result`. */
function siteStuckOnConfirm(): FakeSite {
  return {
    origin: ORIGIN,
    screens: {
      "/": { elements: [LOGIN] },
      "/home": { elements: [MEMBER_ID_BOX, SEARCH] },
      "/result": { elements: [CONFIRM_STUCK] },
      "/done": { elements: [] },
    },
  };
}

/** A one-handler frozen set: a global `needs_human` handler on the banner text. */
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

const FROZEN_SET = frozenSetWith(SUPERVISOR_HANDLER, "Ask a supervisor to approve this", "supervisor_banner_shown");

describe("a takeover ended while the commit is in flight (docs/decisions.md, M06)", () => {
  test("end_run: the reconciliation check hook runs first; the run ends failed, ended_by_operator", async () => {
    let checkCalls = 0;
    // `deps.operator` is a factory the executor calls fresh at each mailbox interaction; one
    // shared instance keeps the script's answers in order across them. `requestOf`'s default
    // mode is `supervised` (docs/decisions.md, M05): the run's first mailbox request is its own
    // start confirmation. The first scripted answer approves it; the second is this test's own
    // takeover.
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "end_run" }]);
    const h = await buildHarness(siteStuckOnConfirm(), {
      operator: () => operator,
      reconciliationCheck: () => {
        checkCalls += 1;
        return Promise.resolve();
      },
    });
    const input = replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH }), { frozenSet: FROZEN_SET });

    const { runId, result } = await runReplay(input, h.deps);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failure.code).toBe("ended_by_operator");
    expect(result.failure.ladder).toEqual({ rung: 4, verdict: "needs_human", ref: "takeover" });
    // The hook is awaited before the run ends (docs/decisions.md, M06). Its answer is not yet
    // wired into `effect` in this milestone (task 4's own comment: "task 5's own hook").
    expect(checkCalls).toBe(1);
    expect(result.effect).toMatchObject({ commit: "uncertain" });

    const events = await h.deps.evidence.events(TENANT, runId);
    if (!events.ok) throw new Error("events failed");
    const escalations = events.value.filter((e) => (e as { event: string }).event === "escalation");
    expect(escalations.length).toBeGreaterThan(0);
  });

  test("the intervention request carries the in-flight notice, the operator_note, and reason needs_human_handler", async () => {
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "end_run" }]);
    const h = await buildHarness(siteStuckOnConfirm(), { operator: () => operator, reconciliationCheck: () => Promise.resolve() });
    const input = replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH }), { frozenSet: FROZEN_SET });

    await runReplay(input, h.deps);

    expect(operator.requests).toHaveLength(2);
    expect(operator.requests[1]).toMatchObject({
      kind: "takeover",
      reason: "needs_human_handler",
      commit: { state: "uncertain", notice: "The commit action was already sent. Do not submit again." },
      operator_note: "A supervisor must approve this transfer.",
      decisions: ["end_run"],
    });
  });

  test("a timeout still runs the reconciliation check first (section 7 §13.3's table)", async () => {
    let checkCalls = 0;
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, "silent"]);
    const h = await buildHarness(siteStuckOnConfirm(), {
      operator: () => operator,
      reconciliationCheck: () => {
        checkCalls += 1;
        return Promise.resolve();
      },
    });
    const input = replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH }), { frozenSet: FROZEN_SET });

    const { result } = await runReplay(input, h.deps);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failure.code).toBe("escalation_timeout");
    expect(checkCalls).toBe(1);
  });
});
