// Proves rungs 2 and 3 through `runReplay`: the frozen ladder facts, `--models off`, policy and
// port gates, the llm/ files (request before reply), the takeover for unsafe_state, the
// `recoveries[]` lines, and the safety rule that a jev outcome never changes the commit state and
// that jev is never asked while a commit is in flight. Design section 5 §8.7, §8.8, §10.8, §11;
// section 3 §5.7, §5.10, §6.5; section 9 §5.3. M09 tasks 4 and 5.
import { describe, expect, test } from "vitest";
import { runReplay } from "../../../src/core/replay/executor.js";
import type { Handler } from "../../../src/core/model/pack.js";
import type { FrozenSet } from "../../../src/core/packs/merge.js";
import { sha256Hex } from "../../../src/core/model/canonical.js";
import type { MergeResult } from "../../../src/core/safety/policy/merge.js";
import { FakeOperator } from "../../../src/fakes/operator.js";
import type { FakeElement, FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import type { JevTroubleOutput, ReviewerInput } from "../../../src/ports/models.js";
import type { ReplayDeps } from "../../../src/core/replay/executor.js";
import { TableClassifier, type ClassifierScript } from "../../../src/fakes/table-classifier.js";
import { TableReviewer, type ReviewerScript } from "../../../src/fakes/table-reviewer.js";
import {
  ORIGIN,
  TENANT,
  authorizationFor,
  buildHarness,
  fixtureSite,
  replayInputOf,
  requestOf,
} from "./executor-harness.js";

const AUTH = authorizationFor("kvfcu/open_sub@1");

const LOGIN: FakeElement = {
  id: "login_button",
  role: "button",
  roleGroup: "button_like",
  name: "Login",
  text: "Login",
  onClick: { go: "/home" },
};
const BOX: FakeElement = {
  id: "member_id_box",
  role: "textbox",
  roleGroup: "text_entry",
  label: "Member ID",
  field: { kind: "text", value: "" },
};
const SEARCH: FakeElement = {
  id: "search_button",
  role: "button",
  roleGroup: "button_like",
  name: "Search",
  text: "Search",
  onClick: { go: "/result" },
};
const CONFIRM: FakeElement = {
  id: "confirm_button",
  role: "button",
  roleGroup: "button_like",
  name: "Confirm",
  text: "Confirm",
  onClick: { go: "/done" },
};
const DONE: FakeElement = {
  id: "account_number_display",
  role: "generic",
  roleGroup: "container",
  label: "Account number",
  text: "SH1234567",
};

/**
 * /home always reloads itself on Search, so the box is empty again and the checkpoint never shows:
 * rung 1 retries twice, then climbs. /home also carries a notice with a Close button that leads to
 * /result, where Confirm shows.
 */
function noticeSite(): FakeSite {
  const search: FakeElement = { ...SEARCH, onClick: { go: "/home" } };
  const notice: FakeElement = {
    id: "notice",
    role: "generic",
    roleGroup: "container",
    text: "Branch profile review is pending.",
  };
  const close: FakeElement = {
    id: "close",
    role: "button",
    roleGroup: "button_like",
    name: "Close",
    text: "Close",
    onClick: { go: "/result" },
  };
  return {
    origin: ORIGIN,
    screens: {
      "/": { elements: [LOGIN] },
      "/home": { elements: [BOX, search, notice, close] },
      "/result": { elements: [CONFIRM] },
      "/done": { elements: [DONE] },
    },
  };
}

/**
 * /home first loads with a notice and no member ID box, so `type_member_id` cannot find its
 * target (its precondition is only a location). Close reloads /home, and the box is there.
 */
function boxSite(): FakeSite {
  let visits = 0;
  const notice: FakeElement = {
    id: "notice",
    role: "generic",
    roleGroup: "container",
    text: "Branch profile review is pending.",
  };
  const close: FakeElement = {
    id: "close",
    role: "button",
    roleGroup: "button_like",
    name: "Close",
    text: "Close",
    onClick: { go: "/home" },
  };
  return {
    origin: ORIGIN,
    screens: {
      "/": { elements: [LOGIN] },
      get "/home"() {
        visits += 1;
        return { elements: visits === 1 ? [notice, close] : [BOX, SEARCH] };
      },
      "/result": { elements: [CONFIRM] },
      "/done": { elements: [DONE] },
    },
  };
}

/** The ID the reviewer sees for its Close button on `site`, read from a probe run that gives up. */
async function closeIdOn(site: () => FakeSite): Promise<string> {
  const probe = new TableReviewer(GIVE_UP);
  const op = new FakeOperator([
    { staff: "op_017", decision: "approved" },
    { staff: "op_017", decision: "end_run" },
  ]);
  const h = await buildHarness(site(), { models: { reviewer: probe }, operator: () => op });
  await runReplay(replayInputOf(h, requestOf({ authorization: AUTH })), h.deps);
  const seen = probe.seen[0]?.input as ReviewerInput | undefined;
  const id = seen?.screen.elements.find((e) => e.name === "Close")?.id ?? "";
  expect(id).toMatch(/^e\d+$/);
  return id;
}

/** Confirm does nothing, so the commit goes `uncertain` and the window is closed. */
function stuckConfirmSite(): FakeSite {
  const stuck: FakeElement = {
    ...CONFIRM,
    onClick: { insert: { id: "b", role: "generic", roleGroup: "container", text: "Waiting" } },
  };
  return {
    origin: ORIGIN,
    screens: {
      "/": { elements: [LOGIN] },
      "/home": { elements: [BOX, SEARCH] },
      "/result": { elements: [stuck] },
      "/done": { elements: [] },
    },
  };
}

const jevScript = (a: Partial<JevTroubleOutput>): ClassifierScript => ({
  trouble: [
    {
      when: {},
      reply: {
        answer: { bucket: "needs_review", handler: null, outcome: null, confidence: 0.5, ...a },
      },
    },
  ],
});
const clickClose = (id: string): ReviewerScript => ({
  fixStep: [
    {
      when: {},
      reply: {
        answer: {
          action: { type: "click", element: id },
          reason: "A notice covers the page.",
          expected: "Confirm shows.",
        },
      },
    },
  ],
});
const GIVE_UP: ReviewerScript = {
  fixStep: [{ when: {}, reply: { answer: { give_up: true, reason: "no" } } }],
};

async function eventsOf(h: Awaited<ReturnType<typeof buildHarness>>, runId: string) {
  const events = await h.deps.evidence.events(TENANT, runId);
  if (!events.ok) throw new Error("events failed");
  return events.value as { event: string; by?: string; data: Record<string, unknown> }[];
}

/** The `llm/` files the finished run lists in run.json, in order. */
async function llmFiles(
  h: Awaited<ReturnType<typeof buildHarness>>,
  runId: string,
): Promise<string[]> {
  const json = await h.deps.evidence.readRunJson(TENANT, runId);
  if (!json.ok) throw new Error("no run.json");
  const files = (json.value as { files: { path: string }[] }).files;
  return files.map((f) => f.path).filter((f) => f.startsWith("llm/"));
}

async function readText(
  h: Awaited<ReturnType<typeof buildHarness>>,
  runId: string,
  path: string,
): Promise<string> {
  const folder = await h.deps.evidence.openRun(TENANT, runId);
  if (!folder.ok) throw new Error("no run folder");
  const got = await folder.value.readFile(path);
  if (!got.ok) throw new Error(`no file ${path}`);
  return new TextDecoder().decode(got.value);
}

async function ladderFacts(
  h: Awaited<ReturnType<typeof buildHarness>>,
  runId: string,
): Promise<unknown> {
  const start = (await eventsOf(h, runId)).find((e) => e.event === "run_start");
  return (start?.data.frozen as { ladder: unknown }).ladder;
}

/** The same policy with the rung switches replaced. */
function withLlm(p: MergeResult, llm: Partial<MergeResult["effective"]["llm"]>): MergeResult {
  return { ...p, effective: { ...p.effective, llm: { ...p.effective.llm, ...llm } } };
}

describe("frozen ladder facts (section 5 §10.8)", () => {
  async function frozen(
    models: ReplayDeps["models"],
    policy?: Partial<MergeResult["effective"]["llm"]>,
  ) {
    const h = await buildHarness(fixtureSite(), models === undefined ? {} : { models });
    const base = replayInputOf(h, requestOf({ authorization: AUTH }));
    const input = policy === undefined ? base : { ...base, policy: withLlm(h.policy, policy) };
    const { runId } = await runReplay(input, h.deps);
    return ladderFacts(h, runId);
  }
  const both = () => ({ classifier: new TableClassifier({}), reviewer: new TableReviewer({}) });

  test("with no models both are false", async () => {
    expect(await frozen(undefined)).toEqual({ jev: false, reviewer: false });
  });

  test("policy on and both ports present: both true, with the three cutoffs", async () => {
    expect(await frozen(both())).toEqual({
      jev: true,
      reviewer: true,
      handler_min: 0.8,
      outcome_min: 0.95,
      reconciliation_min: 0.9,
    });
  });

  test("the app's own cutoffs are frozen", async () => {
    const ladder = await frozen({
      ...both(),
      cutoffs: { handler_min: 0.7, outcome_min: 0.99, reconciliation_min: 0.97 },
    });
    expect(ladder).toMatchObject({ handler_min: 0.7, outcome_min: 0.99, reconciliation_min: 0.97 });
  });

  test("--models off freezes both false", async () => {
    expect(await frozen({ ...both(), off: true })).toEqual({ jev: false, reviewer: false });
  });

  test("a missing port freezes that rung false", async () => {
    expect(await frozen({ reviewer: new TableReviewer({}) })).toEqual({
      jev: false,
      reviewer: true,
    });
    expect(await frozen({ classifier: new TableClassifier({}) })).toMatchObject({
      jev: true,
      reviewer: false,
    });
  });

  test("a policy switch off freezes that rung false", async () => {
    expect(await frozen(both(), { replay_reviewer: false })).toMatchObject({
      jev: true,
      reviewer: false,
    });
    expect(await frozen(both(), { replay_jev: false })).toEqual({ jev: false, reviewer: true });
  });
});

describe("rungs do not act when they are off", () => {
  test("--models off: a stuck step never calls a model", async () => {
    const jev = new TableClassifier({});
    const rev = new TableReviewer({});
    const operator = new FakeOperator([
      { staff: "op_017", decision: "approved" },
      { staff: "op_017", decision: "end_run" },
    ]);
    const h = await buildHarness(noticeSite(), {
      models: { classifier: jev, reviewer: rev, off: true },
      operator: () => operator,
    });
    await runReplay(replayInputOf(h, requestOf({ authorization: AUTH })), h.deps);
    expect(jev.seen).toEqual([]);
    expect(rev.seen).toEqual([]);
  });
});

describe("rung 3 through the executor", () => {
  test("a reviewer click recovers the run; recoveries shows rung 3 via reviewer, and llm/ holds the files", async () => {
    const rev = new TableReviewer(clickClose(await closeIdOn(boxSite)));
    const h = await buildHarness(boxSite(), { models: { reviewer: rev } });
    const { runId, result } = await runReplay(
      replayInputOf(h, requestOf({ authorization: AUTH })),
      h.deps,
    );
    expect(result.status).toBe("success");
    expect(result.recoveries).toContainEqual(
      expect.objectContaining({
        step: "type_member_id",
        rung: 3,
        via: "reviewer",
      }),
    );

    const events = await eventsOf(h, runId);
    const files = await llmFiles(h, runId);
    expect(files).toEqual([
      expect.stringMatching(/^llm\/\d{5}_reviewer_request\.json$/),
      expect.stringMatching(/^llm\/\d{5}_reviewer_reply\.json$/),
    ]);
    // Request first, then reply, both under the same number. The request on disk is the request sent.
    expect(files[0]?.replace("_request", "_reply")).toBe(files[1]);
    expect(await readText(h, runId, files[0] ?? "")).toBe(JSON.stringify(rev.seen[0]?.input));
    // The recovery's ref names the reviewer's own action line.
    const action = events.find((e) => e.by === "reviewer" && e.event === "action");
    const ref = result.recoveries.find((r) => r.via === "reviewer")?.ref;
    expect(ref).toMatch(/^seq:\d+$/);
    expect(ref).toBe(`seq:${String((action as unknown as { seq: number }).seq)}`);
    expect(
      events.some(
        (e) =>
          e.event === "warning" &&
          (e.data.code === "patch_needed" || e.data.code === "handler_needed"),
      ),
    ).toBe(true);
  });

  test("a fix that makes the failed step's checkpoint show lets the run go on with the NEXT step (section 5 §8.6 rule 1, §11.3 step 3)", async () => {
    // Close leads to /result, where Confirm shows: click_search's checkpoint now passes.
    const rev = new TableReviewer(clickClose(await closeIdOn(noticeSite)));
    const h = await buildHarness(noticeSite(), { models: { reviewer: rev } });
    const { result } = await runReplay(
      replayInputOf(h, requestOf({ authorization: AUTH })),
      h.deps,
    );
    expect(result.status).toBe("success");
  });
});

describe("rung 2 through the executor", () => {
  const SESSION: Handler = {
    class: "recoverable",
    id: "notice_closer",
    description: "A pending-review notice covers the page.",
    detector: "never_shown",
    fixtures: { fire: [], no_fire: [] },
    response: [{ type: "navigate", location: "/home", risk: "idempotent" }],
    limits: { per_step: 2, per_run: 2 },
    on_exhausted: { class: "hard_failure", failure: "app_error" },
  };
  const frozenSet: FrozenSet = {
    targets: [],
    conditions: [
      {
        id: "never_shown",
        description: "never",
        check: "text_visible",
        text: "Never on screen",
        match: "contains",
      },
    ],
    handlers: [SESSION],
    handlerScope: new Map([[SESSION.id, { level: "global" as const }]]),
    runStart: {
      ids: [SESSION.id],
      packs: { global: 1 },
      from: { [SESSION.id]: "global" },
      hash: `sha256:${sha256Hex(SESSION.id)}`,
    },
    warnings: [],
  };

  test("a handler jev picks recovers the run; recoveries shows rung 2 via handler; files are written request first", async () => {
    const jev = new TableClassifier(
      jevScript({ bucket: "handler", handler: "notice_closer", confidence: 0.9 }),
    );
    const h = await buildHarness(boxSite(), { models: { classifier: jev } });
    const { runId, result } = await runReplay(
      replayInputOf(h, requestOf({ authorization: AUTH }), { frozenSet }),
      h.deps,
    );
    expect(result.status).toBe("success");
    expect(result.recoveries).toContainEqual(
      expect.objectContaining({
        step: "type_member_id",
        rung: 2,
        via: "handler",
        ref: "notice_closer",
      }),
    );
    const events = await eventsOf(h, runId);
    expect(events.find((e) => e.event === "ladder" && e.by === "jev")?.data).toMatchObject({
      rung: 2,
      bucket: "handler",
      confidence: 0.9,
    });
    const files = await llmFiles(h, runId);
    expect(files).toEqual([
      expect.stringMatching(/^llm\/\d{5}_jev_request\.json$/),
      expect.stringMatching(/^llm\/\d{5}_jev_reply\.json$/),
    ]);
    expect(await readText(h, runId, files[0] ?? "")).toBe(JSON.stringify(jev.seen[0]?.input));
  });

  test("events.jsonl holds each ladder line's input as the plain llm/ path, and the file exists", async () => {
    const jev = new TableClassifier(jevScript({ bucket: "needs_review", confidence: 0.5 }));
    const rev = new TableReviewer(GIVE_UP);
    const operator = new FakeOperator([
      { staff: "op_017", decision: "approved" },
      { staff: "op_017", decision: "end_run" },
    ]);
    const h = await buildHarness(noticeSite(), {
      models: { classifier: jev, reviewer: rev },
      operator: () => operator,
    });
    const { runId } = await runReplay(replayInputOf(h, requestOf({ authorization: AUTH })), h.deps);
    const inputs = (await eventsOf(h, runId))
      .filter((e) => e.event === "ladder" && e.data.input !== undefined)
      .map((e) => e.data.input);
    expect(inputs).toEqual([
      expect.stringMatching(/^llm\/\d{5}_jev_request\.json$/),
      expect.stringMatching(/^llm\/\d{5}_reviewer_request\.json$/),
    ]);
    for (const input of inputs) expect(await readText(h, runId, String(input))).not.toBe("");
  });

  test("unsafe opens a takeover with reason unsafe_state", async () => {
    const operator = new FakeOperator([
      { staff: "op_017", decision: "approved" },
      { staff: "op_017", decision: "end_run" },
    ]);
    const h = await buildHarness(noticeSite(), {
      models: { classifier: new TableClassifier(jevScript({ bucket: "unsafe", confidence: 0.1 })) },
      operator: () => operator,
    });
    await runReplay(replayInputOf(h, requestOf({ authorization: AUTH })), h.deps);
    expect(operator.requests[1]).toMatchObject({ kind: "takeover", reason: "unsafe_state" });
  });

  test("a jev outcome ends the run as business_outcome decided by jev, and the commit state is what plain code set", async () => {
    // member_not_found is declared on click_search; jev names it at 0.97.
    const jev = new TableClassifier(
      jevScript({ bucket: "outcome", outcome: "member_not_found", confidence: 0.97 }),
    );
    const h = await buildHarness(noticeSite(), { models: { classifier: jev } });
    const { result } = await runReplay(
      replayInputOf(h, requestOf({ authorization: AUTH })),
      h.deps,
    );
    expect(result.status).toBe("business_outcome");
    if (result.status !== "business_outcome") throw new Error("expected business_outcome");
    expect(result.outcome).toMatchObject({ code: "member_not_found", decided_by: "jev" });
    // Nothing was committed: plain code's state, never a jev claim of "refused".
    expect(result.effect).toMatchObject({ commit: "not_sent" });
    expect(JSON.stringify(result.effect)).not.toContain("refused");
  });

  test("while the commit is in flight jev is never asked, so it cannot decide an outcome", async () => {
    const jev = new TableClassifier(
      jevScript({ bucket: "outcome", outcome: "member_not_found", confidence: 1 }),
    );
    const rev = new TableReviewer(GIVE_UP);
    const operator = new FakeOperator([
      { staff: "op_017", decision: "approved" },
      { staff: "op_017", decision: "end_run" },
    ]);
    const h = await buildHarness(stuckConfirmSite(), {
      models: { classifier: jev, reviewer: rev },
      operator: () => operator,
      reconciliationCheck: () => Promise.resolve({ kind: "found_outputs_unavailable" }),
    });
    const { result } = await runReplay(
      replayInputOf(h, requestOf({ authorization: AUTH })),
      h.deps,
    );
    expect(jev.seen).toEqual([]);
    expect(rev.seen).toEqual([]);
    expect(result.status).not.toBe("business_outcome");
  });
});
