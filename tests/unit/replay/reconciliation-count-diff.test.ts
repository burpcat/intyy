// Proves the `count_diff` reconciliation check through `runReplay` (owner decisions, 2026-10-01;
// design section 7 §11; section 2 §16): the parent reads a baseline count in a child run before
// its own steps, and after a lost reply plain code compares a second count. One more is found
// (outputs unavailable), the same is absent, anything else goes straight to a human. M05 gate rows:
// count_diff found, absent, unclear. Synthetic values only.
import { describe, expect, test } from "vitest";
import { Artifact as ArtifactSchema } from "../../../src/core/model/artifact.js";
import { runReplay } from "../../../src/core/replay/executor.js";
import type { FrozenSet } from "../../../src/core/packs/merge.js";
import type { Handler } from "../../../src/core/model/pack.js";
import { sha256Hex } from "../../../src/core/model/canonical.js";
import { FakeOperator } from "../../../src/fakes/operator.js";
import type { FakeElement, FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { TableClassifier } from "../../../src/fakes/table-classifier.js";
import { TableReviewer } from "../../../src/fakes/table-reviewer.js";
import {
  CHECK_SUB,
  ORIGIN,
  OPEN_SUB_CHECKED,
  TENANT,
  authorizationFor,
  buildHarness,
  replayInputOf,
  requestOf,
} from "./executor-harness.js";

const LOGIN: FakeElement = { id: "login_button", role: "button", roleGroup: "button_like", name: "Login", text: "Login", onClick: { go: "/home" } };
const MEMBER_ID_BOX: FakeElement = { id: "member_id_box", role: "textbox", roleGroup: "text_entry", label: "Member ID", field: { kind: "text", value: "" } };
const SEARCH: FakeElement = { id: "search_button", role: "button", roleGroup: "button_like", name: "Search", text: "Search", onClick: { go: "/result" } };
/** Confirm goes nowhere: the commit ends `uncertain` and the check runs (same as the other file). */
const CONFIRM_STUCK: FakeElement = { id: "confirm_button", role: "button", roleGroup: "button_like", name: "Confirm", text: "Confirm" };

/** What one visit to `/check` shows: a count, or text that is no integer. */
type Visit = number | "N/A";

/** The count page. The target always holds non-empty text, so a bad value fails at parsing. */
function countScreen(v: Visit): FakeElement[] {
  return [{ id: "subaccount_count_display", role: "generic", roleGroup: "container", label: "Sub-account count", text: String(v) }];
}

/**
 * The flow stuck on Confirm, with a stateful `/check`: the n-th visit shows `visits[n]` (the last
 * one repeats). One visit is one child run, so `visits[0]` is the baseline. `banner` makes Confirm
 * insert a supervisor banner, for the takeover path.
 */
function siteCounting(visits: readonly Visit[], banner = false): { site: FakeSite; visited: () => number } {
  let n = 0;
  const confirm: FakeElement = banner
    ? { ...CONFIRM_STUCK, onClick: { insert: { id: "supervisor_banner", role: "generic", roleGroup: "container", text: "Ask a supervisor to approve this" } } }
    : CONFIRM_STUCK;
  const site: FakeSite = {
    origin: ORIGIN,
    screens: {
      "/": { elements: [LOGIN] },
      "/home": { elements: [MEMBER_ID_BOX, SEARCH] },
      "/result": { elements: [confirm] },
      "/done": { elements: [] },
      get "/check"() {
        const v = visits[Math.min(n, visits.length - 1)];
        n += 1;
        return { elements: countScreen(v ?? "N/A") };
      },
    },
  };
  return { site, visited: () => n };
}

/** `check_sub`, reduced to a count read: integer output `subaccount_count`, no outcomes, only the
 * `check_shown` condition. */
const COUNT_SUB = ArtifactSchema.parse({
  ...CHECK_SUB,
  identity: { ...CHECK_SUB.identity, capability: "count_sub" },
  contract: {
    inputs: CHECK_SUB.contract.inputs,
    outputs: [{ name: "subaccount_count", type: "integer", description: "How many sub-accounts the member has", sensitivity: "financial" }],
    outcomes: [],
    effect: "read_only",
  },
  targets: [{ id: "subaccount_count_display", description: "The sub-account count", clues: { role: "generic", label: "Sub-account count" } }],
  conditions: CHECK_SUB.conditions.filter((c) => c.id === "check_shown"),
  steps: [
    {
      id: "read_count",
      intent: "Read the sub-account count",
      action: { type: "read", target: "subaccount_count_display", source: "text", output: "subaccount_count" },
      precondition: "check_shown",
      checkpoint: "check_shown",
      outcomes: [],
      risk: "idempotent",
      timeout_ms: 5000,
    },
  ],
});

const COUNT_DIFF_CHECK = {
  capability: "kvfcu/count_sub@1",
  mode: "count_diff",
  count_output: "subaccount_count",
  inputs: { member_id: "{input.member_id}" },
  not_found_outcomes: [],
  outputs: {},
};

/** `open_sub_checked`, but its check is the `count_diff` one. */
const OPEN_SUB_COUNT = ArtifactSchema.parse({
  ...OPEN_SUB_CHECKED,
  identity: { ...OPEN_SUB_CHECKED.identity, capability: "open_sub_count" },
  recovery: { commit_point: "click_confirm", reconciliation: { check: COUNT_DIFF_CHECK } },
});

const CAP = "kvfcu/open_sub_count@1";

type Harness = Awaited<ReturnType<typeof buildHarness>>;

/** Builds the harness and seals the two count artifacts. */
async function harnessFor(site: FakeSite, overrides: Parameters<typeof buildHarness>[1] = {}): Promise<Harness> {
  const h = await buildHarness(site, overrides);
  for (const [name, art, n] of [["count_sub", COUNT_SUB, "1000000021"], ["open_sub_count", OPEN_SUB_COUNT, "1000000022"]] as const) {
    const sealed = await h.deps.artifacts.seal(`kvfcu/${name}/cand_2026-01-15_${n}`, "1.0.0", "op_017", art, {});
    if (!sealed.ok) throw new Error(`test setup: ${name} seal failed`);
  }
  return h;
}

/** A long-lived authorization, so the fake clock's waits never expire it (as the other file does). */
function inputFor(h: Harness, capability = CAP, inputs: Record<string, unknown> = {}) {
  const input = replayInputOf(h, requestOf({ authorization: authorizationFor(capability), capability, ...(Object.keys(inputs).length > 0 ? { inputs } : {}) }));
  return {
    ...input,
    request: requestOf({
      authorization: { ...authorizationFor(capability), granted_at: "2026-01-16T08:50:00.000Z", expires_at: "2026-01-16T09:00:00.000Z" },
      capability,
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    }),
  };
}

type Line = { event: string; step: string | null; by?: string; data: Record<string, unknown> };

async function eventsOf(h: Harness, runId: string): Promise<Line[]> {
  const e = await h.deps.evidence.events(TENANT, runId);
  if (!e.ok) throw new Error("events missing");
  return e.value as Line[];
}

const baselineOf = (lines: Line[]) => lines.filter((l) => l.event === "reconciliation_baseline");

const WITH_MODELS = () => ({ classifier: new TableClassifier({}), reviewer: new TableReviewer({}) });

describe("count_diff: plain code decides from two counts (M05 gate rows)", () => {
  test("2 then 3: failed outputs_unavailable, found_by_check, decided by code; the baseline line comes before any gate line", async () => {
    const { site } = siteCounting([2, 3]);
    const h = await harnessFor(site, { operator: () => new FakeOperator([{ staff: "op_017", decision: "approved" }]) });
    const { runId, result } = await runReplay(inputFor(h), h.deps);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failure.code).toBe("outputs_unavailable");
    expect(result.effect).toMatchObject({ commit: "found_by_check", check: { decided_by: "code", staff_id: null } });

    const lines = await eventsOf(h, runId);
    const baseline = baselineOf(lines);
    expect(baseline).toHaveLength(1);
    expect(baseline[0]?.data).toMatchObject({ status: "read" });
    const firstGate = lines.findIndex((l) => l.event === "gate");
    expect(firstGate).toBeGreaterThan(-1);
    expect(lines.indexOf(baseline[0] as Line)).toBeLessThan(firstGate);

    // Two children: the baseline and the check; the effect names the second.
    const runs = await h.deps.evidence.listRuns(TENANT);
    expect(runs).toHaveLength(3);
    expect(result.effect?.check?.run_id).not.toBe(baseline[0]?.data.check_run_id);
  });

  test("2 then 2, operator says no_retry: absent_by_check", async () => {
    const { site } = siteCounting([2, 2]);
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "no_retry" }]);
    const h = await harnessFor(site, { operator: () => operator });
    const { result } = await runReplay(inputFor(h), h.deps);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.effect).toMatchObject({ commit: "absent_by_check", check: { decided_by: "code" } });
    expect(result.failure.safe_to_retry).toBe(true);
  });

  test("2 then 4: reconciliation_unclear goes straight to a human; jev and the reviewer are never called", async () => {
    const { site } = siteCounting([2, 4]);
    const models = WITH_MODELS();
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "not_found" }]);
    const h = await harnessFor(site, { operator: () => operator, models });
    const { runId } = await runReplay(inputFor(h), h.deps);

    expect(operator.requests[1]).toMatchObject({ kind: "reconciliation_decision", reason: "reconciliation_unclear" });
    expect(models.classifier.seen).toEqual([]);
    expect(models.reviewer.seen).toEqual([]);
    const recon = (await eventsOf(h, runId)).filter((l) => l.event === "escalation" && l.data.kind === "reconciliation_decision");
    expect(recon.length).toBeGreaterThanOrEqual(1);
    expect(recon.every((l) => l.data.reason === "reconciliation_unclear")).toBe(true);
  });
});

describe("count_diff: an unreadable baseline", () => {
  test("the baseline line says unavailable, no second child runs, and a human decides", async () => {
    const { site, visited } = siteCounting(["N/A", 3]);
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "not_found" }]);
    const models = WITH_MODELS();
    const h = await harnessFor(site, { operator: () => operator, models });
    const { runId, result } = await runReplay(inputFor(h), h.deps);

    const baseline = baselineOf(await eventsOf(h, runId));
    expect(baseline).toHaveLength(1);
    expect(baseline[0]?.data).toMatchObject({ status: "unavailable", count: null });
    // Why one visit: with no baseline, no later count can decide, so no check child is started.
    expect(visited()).toBe(1);
    expect(await h.deps.evidence.listRuns(TENANT)).toHaveLength(2);
    expect(operator.requests[1]).toMatchObject({ kind: "reconciliation_decision", reason: "reconciliation_unclear" });
    expect(models.classifier.seen).toEqual([]);
    // The human said "not_found", which is a decision, not a retry; the commit is not claimed found.
    expect(result.effect?.commit).not.toBe("found_by_check");
    expect(result.effect?.check).toBeUndefined();
  });
});

describe("count_diff: when no baseline is taken", () => {
  test("a reference-mode artifact writes no baseline line", async () => {
    // `check_sub` reads `account_number`, so `/check` shows one.
    const { site } = siteCounting([2]);
    const readable: FakeSite = {
      ...site,
      screens: {
        "/": { elements: [LOGIN] },
        "/home": { elements: [MEMBER_ID_BOX, SEARCH] },
        "/result": { elements: [CONFIRM_STUCK] },
        "/done": { elements: [] },
        "/check": { elements: [{ id: "account_number_display", role: "generic", roleGroup: "container", label: "Account number", text: "SH9999999" }] },
      },
    };
    const h = await harnessFor(readable, { operator: () => new FakeOperator([{ staff: "op_017", decision: "approved" }]) });
    const { runId, result } = await runReplay(inputFor(h, "kvfcu/open_sub_checked@1"), h.deps);

    expect(baselineOf(await eventsOf(h, runId))).toEqual([]);
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.effect).toMatchObject({ commit: "found_by_check", check: { decided_by: "code" } });
    expect(result.outputs).toEqual({ account_number: "SH9999999" });
    // One child only: the check, none before.
    expect(await h.deps.evidence.listRuns(TENANT)).toHaveLength(2);
  });

  test("a deps.reconciliationCheck override skips the baseline", async () => {
    const { site, visited } = siteCounting([2, 3]);
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "not_found" }]);
    const h = await harnessFor(site, { operator: () => operator, reconciliationCheck: () => Promise.resolve({ kind: "unclear" }) });
    const { runId } = await runReplay(inputFor(h), h.deps);

    expect(baselineOf(await eventsOf(h, runId))).toEqual([]);
    expect(visited()).toBe(0);
    expect(await h.deps.evidence.listRuns(TENANT)).toHaveLength(1);
  });

  test("an invalid input request starts no baseline child run", async () => {
    const { site, visited } = siteCounting([2, 3]);
    const h = await harnessFor(site);
    // `member_id` must be six digits (the artifact's constraint); this one is not.
    const { result } = await runReplay(inputFor(h, CAP, { member_id: "12ab" }), h.deps);

    expect(result.status).toBe("rejected");
    expect(visited()).toBe(0);
    expect((await h.deps.evidence.listRuns(TENANT)).length).toBeLessThanOrEqual(1);
    for (const id of await h.deps.evidence.listRuns(TENANT)) {
      expect(baselineOf(await eventsOf(h, id))).toEqual([]);
    }
  });
});

const SUPERVISOR_HANDLER: Handler = {
  class: "needs_human",
  id: "supervisor_required",
  description: "a supervisor must approve this",
  detector: "supervisor_banner_shown",
  fixtures: { fire: [], no_fire: [] },
  operator_note: "A supervisor must approve this transfer.",
};
const SUPERVISOR_FROZEN_SET: FrozenSet = {
  targets: [],
  conditions: [{ id: "supervisor_banner_shown", description: "supervisor_banner_shown", check: "text_visible", text: "Ask a supervisor to approve this", match: "contains" }],
  handlers: [SUPERVISOR_HANDLER],
  handlerScope: new Map([[SUPERVISOR_HANDLER.id, { level: "global" as const }]]),
  runStart: { ids: [SUPERVISOR_HANDLER.id], packs: { global: 1 }, from: { [SUPERVISOR_HANDLER.id]: "global" }, hash: `sha256:${sha256Hex(SUPERVISOR_HANDLER.id)}` },
  warnings: [],
};

describe("count_diff: a takeover ended while the commit is in flight", () => {
  test("the takeover path uses the same baseline: 2 then 3 is found_by_check, and the takeover's ending stands", async () => {
    const { site } = siteCounting([2, 3], true);
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "end_run" }]);
    const h = await harnessFor(site, { operator: () => operator });
    const { runId, result } = await runReplay({ ...inputFor(h), frozenSet: SUPERVISOR_FROZEN_SET }, h.deps);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failure.code).toBe("ended_by_operator");
    expect(result.effect).toMatchObject({ commit: "found_by_check", check: { decided_by: "code" } });
    const baseline = baselineOf(await eventsOf(h, runId));
    expect(baseline).toHaveLength(1);
    expect(baseline[0]?.data).toMatchObject({ status: "read" });
  });

  test("2 then 2 on the takeover path is absent_by_check", async () => {
    const { site } = siteCounting([2, 2], true);
    const operator = new FakeOperator([{ staff: "op_017", decision: "approved" }, { staff: "op_017", decision: "end_run" }]);
    const h = await harnessFor(site, { operator: () => operator });
    const { result } = await runReplay({ ...inputFor(h), frozenSet: SUPERVISOR_FROZEN_SET }, h.deps);

    expect(result.status).toBe("failed");
    expect(result.effect).toMatchObject({ commit: "absent_by_check" });
  });
});
