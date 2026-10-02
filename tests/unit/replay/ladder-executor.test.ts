// Proves the ladder end to end, through `runReplay` (design section 5 §8.13 walkthrough,
// §8.2 pre-commit sweep in the commit branch; section 3 §6.5 frozen facts, §7.5 evidence
// levels; section 7 §10 the `sign_in` handler recovery). Every scenario reuses the M05 fixture
// artifacts (`SIGN_IN`, `OPEN_SUB`) through a custom, stateful `FakeSite`: a screen the site
// counts visits for, so a retry or a handler's own navigate sees the app "heal" the second
// time round, with no live browser involved. M06 task 2/3.
import { describe, expect, test } from "vitest";
import { runReplay } from "../../../src/core/replay/executor.js";
import type { Handler } from "../../../src/core/model/pack.js";
import type { FrozenSet } from "../../../src/core/packs/merge.js";
import { sha256Hex } from "../../../src/core/model/canonical.js";
import type { FakeElement, FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import {
  ACCOUNT_NUMBER,
  ORIGIN,
  TENANT,
  authorizationFor,
  buildHarness,
  fixtureSite,
  replayInputOf,
  requestOf,
} from "./executor-harness.js";

const OPEN_SUB_AUTH = authorizationFor("kvfcu/open_sub@1");

/** A one-handler frozen set: one global `recoverable` handler, no targets. */
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

const MEMBER_ID_BOX: FakeElement = { id: "member_id_box", role: "textbox", roleGroup: "text_entry", label: "Member ID", field: { kind: "text", value: "" } };
const CONFIRM_BUTTON: FakeElement = { id: "confirm_button", role: "button", roleGroup: "button_like", name: "Confirm", text: "Confirm", onClick: { go: "/done" } };
const DONE_SCREEN: FakeElement = { id: "account_number_display", role: "generic", roleGroup: "container", label: "Account number", text: ACCOUNT_NUMBER };
const START_SCREEN: FakeElement = { id: "login_button", role: "button", roleGroup: "button_like", name: "Login", text: "Login", onClick: { go: "/home" } };

/** A Search button that navigates to `target`. */
function searchButton(target: string): FakeElement {
  return { id: "search_button", role: "button", roleGroup: "button_like", name: "Search", text: "Search", onClick: { go: target } };
}

/** A plain, generic text element. */
function textElement(id: string, text: string): FakeElement {
  return { id, role: "generic", roleGroup: "container", text };
}

describe("a hang recovers on an idempotent step (section 5 §14)", () => {
  test("the app 'glitches' back to home once; a plain retry resumes and the run succeeds", async () => {
    // `/home`'s Search button targets itself on its second load (the glitch), and `/result`
    // every other time: the ladder's own retry, which only re-observes and never navigates,
    // sees this by resuming at `type_member_id`, which retypes and re-clicks. (The first load is the prelude's own login click, and it is also the page the task's
    // first click reads: the task no longer re-navigates to an entry it already stands on.)
    let homeVisits = 0;
    const site: FakeSite = {
      origin: ORIGIN,
      screens: {
        "/": { elements: [START_SCREEN] },
        get "/home"() {
          homeVisits += 1;
          const target = homeVisits === 1 ? "/home" : "/result";
          return { elements: [MEMBER_ID_BOX, searchButton(target)] };
        },
        "/result": { elements: [CONFIRM_BUTTON] },
        "/done": { elements: [DONE_SCREEN] },
      },
    };
    const h = await buildHarness(site);
    const { result } = await runReplay(replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH })), h.deps);

    expect(result.status).toBe("success");
    expect(result.recoveries).toEqual([
      expect.objectContaining({ step: "click_search", rung: 1, via: "retry", resumed_at: "type_member_id" }),
    ]);
  });
});

describe("the sign_in handler recovers a lost session (section 7 §10, §8.13)", () => {
  test("the result page shows the expired banner once; sign_in resumes the search and succeeds", async () => {
    let resultVisits = 0;
    const site: FakeSite = {
      origin: ORIGIN,
      screens: {
        "/": { elements: [START_SCREEN] },
        "/home": { elements: [MEMBER_ID_BOX, searchButton("/result")] },
        get "/result"() {
          resultVisits += 1;
          return resultVisits === 1
            ? { elements: [textElement("expired_text", "Your session has expired")] }
            : { elements: [CONFIRM_BUTTON] };
        },
        "/done": { elements: [DONE_SCREEN] },
      },
    };
    const handler: Handler = {
      class: "recoverable",
      id: "session_expired",
      description: "the session expired",
      detector: "session_expired_shown",
      fixtures: { fire: [], no_fire: [] },
      response: [{ type: "sign_in", risk: "idempotent" }],
      limits: { per_step: 2, per_run: 2 },
      on_exhausted: { class: "hard_failure", failure: "app_error" },
    };
    const h = await buildHarness(site);
    const input = replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH }), {
      frozenSet: frozenSetWith(handler, "Your session has expired", "session_expired_shown"),
    });
    const { runId, result } = await runReplay(input, h.deps);

    expect(result.status).toBe("success");
    expect(result.recoveries).toEqual([
      expect.objectContaining({ step: "click_search", rung: 1, via: "handler", ref: "session_expired", resumed_at: "type_member_id" }),
    ]);

    const events = await h.deps.evidence.events(TENANT, runId);
    if (!events.ok) throw new Error("events failed");
    const signInGate = events.value.find(
      (e) => (e as { event: string }).event === "gate" && (e as { data: { action: string } }).data.action === "sign_in",
    );
    expect(signInGate).toMatchObject({ data: { actor: "handler", action: "sign_in", decision: "allowed" } });
  });
});

describe("the sign_in handler on the session capability itself (no session artifact)", () => {
  test("the start page shows the expired banner once; sign_in starts the sign-in over at its entry and succeeds", async () => {
    let startVisits = 0;
    const site: FakeSite = {
      origin: ORIGIN,
      screens: {
        get "/"() {
          startVisits += 1;
          return startVisits === 1
            ? { elements: [textElement("expired_text", "Your session has expired")] }
            : { elements: [START_SCREEN] };
        },
        "/home": { elements: [MEMBER_ID_BOX] },
      },
    };
    const handler: Handler = {
      class: "recoverable",
      id: "session_expired",
      description: "the session expired",
      detector: "session_expired_shown",
      fixtures: { fire: [], no_fire: [] },
      response: [{ type: "sign_in", risk: "idempotent" }],
      limits: { per_step: 2, per_run: 2 },
      on_exhausted: { class: "hard_failure", failure: "app_error" },
    };
    const h = await buildHarness(site);
    const input = replayInputOf(h, requestOf({ capability: "kvfcu/sign_in@1", inputs: {} }), {
      frozenSet: frozenSetWith(handler, "Your session has expired", "session_expired_shown"),
    });
    const { result } = await runReplay(input, h.deps);

    expect(result.status).toBe("success");
    expect(result.recoveries).toEqual([
      expect.objectContaining({ step: "click_login", via: "handler", ref: "session_expired", resumed_at: "click_login" }),
    ]);
    expect(startVisits).toBe(2);
  });
});

describe("frozen ladder facts (docs/decisions.md, M06)", () => {
  test("run_start freezes ladder.jev and ladder.reviewer false", async () => {
    const h = await buildHarness(fixtureSite());
    const { runId } = await runReplay(replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH })), h.deps);

    const events = await h.deps.evidence.events(TENANT, runId);
    if (!events.ok) throw new Error("events failed");
    const runStart = events.value.find((e) => (e as { event: string }).event === "run_start");
    expect(runStart).toMatchObject({ data: { frozen: { ladder: { jev: false, reviewer: false } } } });
  });
});

describe("ladder-start capture (section 3 §7.5, docs/decisions.md M06)", () => {
  test("every ladder entry, recovered or failed, saves a screenshot and a masked a11y snapshot", async () => {
    const h = await buildHarness(fixtureSite({ homeMissingBox: true }));
    const { runId, result } = await runReplay(replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH })), h.deps);

    expect(result.status).toBe("failed");
    const events = await h.deps.evidence.events(TENANT, runId);
    if (!events.ok) throw new Error("events failed");
    const ladderLines = events.value.filter((e) => (e as { event: string }).event === "ladder") as {
      data: { verdict: string; files: readonly string[] };
    }[];
    expect(ladderLines.length).toBeGreaterThan(0);
    expect(ladderLines.some((l) => l.data.verdict === "recovered")).toBe(true);
    expect(ladderLines.some((l) => l.data.verdict === "climb")).toBe(true);
    for (const line of ladderLines) {
      expect(line.data.files.some((f) => f.startsWith("screens/"))).toBe(true);
      expect(line.data.files.some((f) => f.startsWith("a11y/"))).toBe(true);
      expect(line.data.files.some((f) => f.startsWith("dom/"))).toBe(false);
    }
  });

  test("evidence level minimal captures none of it", async () => {
    const h = await buildHarness(fixtureSite({ homeMissingBox: true }));
    h.policy.effective.evidence.level = "minimal";
    const { runId } = await runReplay(replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH })), h.deps);

    const events = await h.deps.evidence.events(TENANT, runId);
    if (!events.ok) throw new Error("events failed");
    const ladderLines = events.value.filter((e) => (e as { event: string }).event === "ladder") as { data: { files: readonly string[] } }[];
    expect(ladderLines.length).toBeGreaterThan(0);
    for (const line of ladderLines) expect(line.data.files).toEqual([]);
  });
});

describe("the pre-commit sweep, in the commit branch (section 5 §8.3)", () => {
  /** `/result` shows Confirm plus a leftover reminder popup on its first load, and Confirm alone
   * on any later load (a handler's own re-navigate, or the executor's retry). */
  function siteWithPopup(): FakeSite {
    let resultVisits = 0;
    return {
      origin: ORIGIN,
      screens: {
        "/": { elements: [START_SCREEN] },
        "/home": { elements: [MEMBER_ID_BOX, searchButton("/result")] },
        get "/result"() {
          resultVisits += 1;
          const popup = textElement("reminder_popup", "Reminder: enroll in text alerts");
          return { elements: resultVisits === 1 ? [CONFIRM_BUTTON, popup] : [CONFIRM_BUTTON] };
        },
        "/done": { elements: [DONE_SCREEN] },
      },
    };
  }

  test("a recoverable handler clears the popup, and the commit still goes through", async () => {
    const handler: Handler = {
      class: "recoverable",
      id: "clear_reminder",
      description: "clears the reminder popup",
      detector: "reminder_shown",
      fixtures: { fire: [], no_fire: [] },
      response: [{ type: "navigate", location: "/result", risk: "idempotent" }],
      limits: { per_step: 2, per_run: 2 },
      on_exhausted: { class: "hard_failure", failure: "app_error" },
    };
    const h = await buildHarness(siteWithPopup());
    const input = replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH }), {
      frozenSet: frozenSetWith(handler, "Reminder: enroll in text alerts", "reminder_shown"),
    });
    const { runId, result } = await runReplay(input, h.deps);

    expect(result.status).toBe("success");
    expect(result.effect).toMatchObject({ commit: "confirmed" });
    const events = await h.deps.evidence.events(TENANT, runId);
    if (!events.ok) throw new Error("events failed");
    expect(events.value.some((e) => (e as { event: string }).event === "commit_intent")).toBe(true);
  });

  test("a hard_failure handler matching the sweep ends the run with the commit not_sent, and no commit_intent line", async () => {
    // A `business_outcome` handler needs the step to declare its code (section 5 §9.4); the
    // commit step declares none, so that class always ends `undeclared_outcome` here. The
    // `hard_failure` class needs no such declaration, and section 5 §8.10 lists both classes
    // as ending the run the same way at a sweep match: the commit stays `not_sent`.
    const handler: Handler = {
      class: "hard_failure",
      id: "reminder_blocks_commit",
      description: "a reminder popup is showing",
      detector: "reminder_shown",
      fixtures: { fire: [], no_fire: [] },
      failure: "app_error",
    };
    const h = await buildHarness(siteWithPopup());
    const input = replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH }), {
      frozenSet: frozenSetWith(handler, "Reminder: enroll in text alerts", "reminder_shown"),
    });
    const { runId, result } = await runReplay(input, h.deps);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failure.code).toBe("app_error");
    expect(result.effect).toMatchObject({ commit: "not_sent", performed_by: null, sent_at: null });
    const events = await h.deps.evidence.events(TENANT, runId);
    if (!events.ok) throw new Error("events failed");
    expect(events.value.some((e) => (e as { event: string }).event === "commit_intent")).toBe(false);
  });
});
