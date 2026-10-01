// Proves a takeover's claim, handback and outcome decisions through `runReplay`: the lease moves
// takeover_requested, claimed, handed_back; a claim writes an `escalation` line; set_outcome ends
// the run `business_outcome` with `decided_by: human`; and on a commit in flight it makes the
// commit `refused` with no reconciliation check. Design section 7 §12.2, §13.2, §13.3;
// docs/decisions.md, M07. M07 task 2.
import { describe, expect, test } from "vitest";
import { Artifact as ArtifactSchema, type Artifact } from "../../../src/core/model/artifact.js";
import { CandidateDecision } from "../../../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../../../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../../../src/core/model/candidate-runs.js";
import type { Handler } from "../../../src/core/model/pack.js";
import { sha256Hex } from "../../../src/core/model/canonical.js";
import type { FrozenSet } from "../../../src/core/packs/merge.js";
import type { CandidateFiles } from "../../../src/core/recorder/candidates.js";
import { runReplay, type ReplayInput } from "../../../src/core/replay/executor.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { FakeOperator, type FakeAnswer } from "../../../src/fakes/operator.js";
import type { FakeElement, FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { FakeCandidateStore } from "../../../src/fakes/stores.js";
import {
  CHECK_SUB,
  OPEN_SUB,
  ORIGIN,
  SIGN_IN,
  TENANT,
  authorizationFor,
  buildHarness,
  fixtureSite,
  replayInputOf,
  requestOf,
} from "../replay/executor-harness.js";

type Line = { event: string; step: string | null; by: string; data: Record<string, unknown> };

const OPEN_SUB_AUTH = authorizationFor("kvfcu/open_sub@1");
const START = { staff: "op_017", decision: "approved" } as const;
const CLAIM = { staff: "op_017", claimed: true } as const;
const OUTCOME = "member_not_found";

/** What one run left: the operator, the result, and the log. */
async function runWith(
  site: FakeSite,
  answers: FakeAnswer[],
  extra: { input?: Partial<ReplayInput>; artifact?: Artifact; frozenSet?: FrozenSet; checks?: { calls: number } } = {},
) {
  const operator = new FakeOperator(answers);
  const overrides: Parameters<typeof buildHarness>[1] = { operator: () => operator };
  if (extra.checks !== undefined) {
    const checks = extra.checks;
    overrides.reconciliationCheck = () => {
      checks.calls += 1;
      return Promise.resolve({ kind: "found_outputs_unavailable" });
    };
  }
  if (extra.artifact !== undefined) overrides.artifacts = await storeWith(extra.artifact);
  const h = await buildHarness(site, overrides);
  const input = replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH }), {
    ...(extra.frozenSet === undefined ? {} : { frozenSet: extra.frozenSet }),
    ...extra.input,
  });
  const { runId, result } = await runReplay(input, h.deps);
  const events = await h.deps.evidence.events(TENANT, runId);
  if (!events.ok) throw new Error("events failed");
  return { operator, result, lines: events.value as Line[] };
}

/** A store sealed with the fixture artifacts, but `open_sub` replaced by `task`. */
async function storeWith(task: Artifact) {
  const store = new FakeCandidateStore<CandidateFiles, ReturnType<typeof CandidateDecision.parse>>(
    {
      files: { "runs.json": CandidateRuns, "candidate.json": ArtifactSchema, "issues.json": CandidateIssues },
      decision: CandidateDecision,
    },
    new SteppingClock(),
  );
  await store.seal("kvfcu/sign_in/cand_2026-01-15_1000000001", "1.0.0", "op_017", SIGN_IN, {});
  await store.seal("kvfcu/open_sub/cand_2026-01-15_1000000002", "1.0.0", "op_017", task, {});
  await store.seal("kvfcu/check_sub/cand_2026-01-15_1000000003", "1.0.0", "op_017", CHECK_SUB, {});
  return store;
}

const leaseReasons = (lines: Line[]): unknown[] => lines.filter((l) => l.event === "lease").map((l) => l.data["reason"]);
const takeoverLines = (lines: Line[]): Line[] =>
  lines.filter((l) => l.event === "escalation" && l.data["kind"] === "takeover");

/** `open_sub` where `type_member_id` also declares the `member_not_found` outcome. */
const TYPE_DECLARES: Artifact = {
  ...OPEN_SUB,
  steps: OPEN_SUB.steps.map((s) => (s.id === "type_member_id" ? { ...s, outcomes: [OUTCOME] } : s)),
};

// Home has no Member ID box: `type_member_id`'s precondition is location-only, so the ladder
// climbs to a takeover (docs/decisions.md, M06) at a step that declares an outcome.
const stuckAtSearch = (): FakeSite => fixtureSite({ homeMissingBox: true });
const AT_TYPE = { artifact: TYPE_DECLARES };

describe("claim and handback (section 7 §12.2)", () => {
  test("the lease goes takeover_requested, claimed, handed_back; the claim is logged; the request closes resolved", async () => {
    const { operator, lines } = await runWith(stuckAtSearch(), [
      START,
      CLAIM,
      { staff: "op_017", released: true, note: "Searched by hand." },
    ], AT_TYPE);

    expect(operator.requests[1]).toMatchObject({ kind: "takeover", lease: "nobody" });
    expect(operator.closed[1]).toBe("resolved");
    expect(leaseReasons(lines)).toEqual([
      "run_start",
      "awaiting_decision",
      "decided",
      "takeover_requested",
      "claimed",
      "handed_back",
      "run_end",
    ]);
    const lease = lines.filter((l) => l.event === "lease");
    expect(lease.find((l) => l.data["reason"] === "claimed")).toMatchObject({
      by: "human",
      data: { from: "nobody", to: "human", staff_id: "op_017", implicit: false },
    });
    expect(lease.find((l) => l.data["reason"] === "handed_back")).toMatchObject({
      by: "human",
      data: { from: "human", to: "nobody", staff_id: "op_017" },
    });

    const claimed = takeoverLines(lines).find((l) => l.data["state"] === "claimed");
    expect(claimed).toMatchObject({ by: "human", data: { staff_id: "op_017", implicit: false } });
    // The claim moves the deadline to 60 minutes from the claim: a later time than the open one.
    expect(String(claimed?.data["deadline"])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const resolved = takeoverLines(lines).find((l) => l.data["state"] === "resolved");
    expect(resolved).toMatchObject({ by: "human", data: { decision: "handed_back", staff_id: "op_017" } });
  });

  test("a native-dialog answer is logged on the takeover", async () => {
    const { lines } = await runWith(stuckAtSearch(), [
      START,
      CLAIM,
      { staff: "op_017", dialog: "accept" },
      { staff: "op_017", decision: "end_run" },
    ], AT_TYPE);
    const dialog = takeoverLines(lines).find((l) => l.data["state"] === "dialog_answered");
    expect(dialog).toMatchObject({ by: "human", data: { staff_id: "op_017", decision: "accept" } });
  });
});

describe("set_outcome (section 7 §13.2)", () => {
  test("the request offers set_outcome and lists the step's declared outcome", async () => {
    const { operator } = await runWith(stuckAtSearch(), [START, { staff: "op_017", decision: "end_run" }], AT_TYPE);
    expect(operator.requests[1]).toMatchObject({
      kind: "takeover",
      decisions: ["end_run", "set_outcome"],
      outcomes: [OUTCOME],
    });
  });

  test("a declared code ends the run business_outcome, decided_by human, set_by the staff ID", async () => {
    const { result, lines } = await runWith(stuckAtSearch(), [
      START,
      CLAIM,
      { staff: "op_017", decision: "set_outcome", outcome: OUTCOME },
    ], AT_TYPE);
    expect(result.status).toBe("business_outcome");
    if (result.status !== "business_outcome") throw new Error("expected business_outcome");
    expect(result.outcome).toMatchObject({ code: OUTCOME, step: "type_member_id", decided_by: "human", set_by: "op_017" });
    expect(lines.findLast((l) => l.event === "run_end")?.data).toMatchObject({ status: "business_outcome", code: OUTCOME });
    const resolved = takeoverLines(lines).find((l) => l.data["state"] === "resolved");
    expect(resolved?.data).toMatchObject({ decision: "set_outcome", outcome: OUTCOME, staff_id: "op_017" });
  });

  test("a code the step does not declare ends the run as end_run: failed, ended_by_operator", async () => {
    const { result } = await runWith(stuckAtSearch(), [
      START,
      CLAIM,
      { staff: "op_017", decision: "set_outcome", outcome: "no_such_code" },
    ], AT_TYPE);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failure.code).toBe("ended_by_operator");
  });

  test("set_outcome with no code at all ends the run as end_run", async () => {
    const { result } = await runWith(stuckAtSearch(), [START, CLAIM, { staff: "op_017", decision: "set_outcome" }], AT_TYPE);
    expect(result.status).toBe("failed");
  });
});

// ---- A commit in flight -------------------------------------------------------------------

const LOGIN: FakeElement = { id: "login_button", role: "button", roleGroup: "button_like", name: "Login", text: "Login", onClick: { go: "/home" } };
const MEMBER_ID_BOX: FakeElement = { id: "member_id_box", role: "textbox", roleGroup: "text_entry", label: "Member ID", field: { kind: "text", value: "" } };
const SEARCH: FakeElement = { id: "search_button", role: "button", roleGroup: "button_like", name: "Search", text: "Search", onClick: { go: "/result" } };
/** Confirm only inserts a banner and never navigates, so the commit's checkpoint never comes:
 * the commit is `uncertain` (section 2 §16.6). The banner also fires the needs_human handler. */
const CONFIRM_STUCK: FakeElement = {
  id: "confirm_button",
  role: "button",
  roleGroup: "button_like",
  name: "Confirm",
  text: "Confirm",
  onClick: { insert: { id: "supervisor_banner", role: "generic", roleGroup: "container", text: "Ask a supervisor to approve this" } },
};
const siteStuckOnConfirm = (): FakeSite => ({
  origin: ORIGIN,
  screens: {
    "/": { elements: [LOGIN] },
    "/home": { elements: [MEMBER_ID_BOX, SEARCH] },
    "/result": { elements: [CONFIRM_STUCK] },
    "/done": { elements: [] },
  },
});

const SUPERVISOR_HANDLER: Handler = {
  class: "needs_human",
  id: "supervisor_required",
  description: "a supervisor must approve this",
  detector: "supervisor_banner_shown",
  fixtures: { fire: [], no_fire: [] },
  operator_note: "A supervisor must approve this transfer.",
};
const FROZEN: FrozenSet = {
  targets: [],
  conditions: [
    { id: "supervisor_banner_shown", description: "banner", check: "text_visible", text: "Ask a supervisor to approve this", match: "contains" },
  ],
  handlers: [SUPERVISOR_HANDLER],
  handlerScope: new Map([[SUPERVISOR_HANDLER.id, { level: "global" as const }]]),
  runStart: { ids: [SUPERVISOR_HANDLER.id], packs: { global: 1 }, from: { [SUPERVISOR_HANDLER.id]: "global" }, hash: `sha256:${sha256Hex("h")}` },
  warnings: [],
};

/** `open_sub` with the commit step also declaring the `member_not_found` outcome. */
const COMMIT_DECLARES: Artifact = {
  ...OPEN_SUB,
  steps: OPEN_SUB.steps.map((s) => (s.id === "click_confirm" ? { ...s, outcomes: [OUTCOME] } : s)),
};

describe("set_outcome on a commit in flight (section 7 §13.2)", () => {
  test("the commit becomes refused, decided_by human, and no reconciliation check runs", async () => {
    const checks = { calls: 0 };
    const { operator, result } = await runWith(
      siteStuckOnConfirm(),
      [START, CLAIM, { staff: "op_017", decision: "set_outcome", outcome: OUTCOME }],
      { artifact: COMMIT_DECLARES, frozenSet: FROZEN, checks },
    );

    expect(operator.requests[1]).toMatchObject({
      kind: "takeover",
      reason: "needs_human_handler",
      commit: { state: "uncertain" },
      decisions: ["end_run", "set_outcome"],
    });
    expect(result.status).toBe("business_outcome");
    if (result.status !== "business_outcome") throw new Error("expected business_outcome");
    expect(result.outcome).toMatchObject({ code: OUTCOME, decided_by: "human", set_by: "op_017" });
    expect(result.effect).toMatchObject({ commit: "refused" });
    expect(checks.calls).toBe(0);
  });

  test("end_run on the same takeover still runs the reconciliation check (the M06 rule stands)", async () => {
    const checks = { calls: 0 };
    const { result } = await runWith(siteStuckOnConfirm(), [START, CLAIM, { staff: "op_017", decision: "end_run" }], {
      artifact: COMMIT_DECLARES,
      frozenSet: FROZEN,
      checks,
    });
    expect(checks.calls).toBe(1);
    expect(result.status).toBe("failed");
  });
});
