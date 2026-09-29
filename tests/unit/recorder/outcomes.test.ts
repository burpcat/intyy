// Proves outcomes.ts (section 6 §14.8): alignment by target and action type, and the outcome
// condition built from `report_outcome.proof`.
import { describe, expect, test } from "vitest";
import type { Step } from "../../../src/core/model/artifact/steps.js";
import type { Target } from "../../../src/core/model/artifact/targets.js";
import { RunSpec } from "../../../src/core/model/runspec.js";
import { ConditionRegistry } from "../../../src/core/recorder/conditions.js";
import type { RecorderIssue } from "../../../src/core/recorder/issues.js";
import { alignNegativeRun, attachOutcome, buildOutcome } from "../../../src/core/recorder/outcomes.js";
import type { Snapshots } from "../../../src/core/recorder/steps.js";
import type { TaggedAction } from "../../../src/core/recorder/tags.js";

const STEPS: Step[] = [
  {
    id: "click_search",
    intent: "Search for the member.",
    action: { type: "click", target: "search_button" },
    precondition: "p",
    checkpoint: "c",
    outcomes: [],
    risk: "idempotent",
    timeout_ms: 8000,
  },
];

const TARGETS: Target[] = [
  { id: "search_button", description: "Search", clues: { role: "button", name: "Search" } },
];

function negAction(): TaggedAction {
  return {
    runId: "run_2026-09-24_neg",
    seq: 3,
    turn: 2,
    tool: "click",
    target: "e3",
    value: null,
    format: null,
    option: null,
    checked: null,
    key: null,
    result: "ok",
    dispatched: true,
    tag: "flow_step",
    humanTag: null,
    effectiveTag: "flow_step",
    reason: "Search for the member.",
    expected: "No member found.",
    corrects: null,
    fingerprint: {
      role: "button",
      name: "Search",
      label: null,
      text: "Search",
      region: null,
      crop: null,
      crop_dropped: "no_crop_rule",
      path: "form > button[1]",
      within: null,
      max_length: null,
      field_kind: null,
      uniqueness: 1,
    },
    beforeLocation: "/home.do",
    afterLocation: "/home.do",
    at: "2026-09-24T10:00:00.000Z",
    afterAt: "2026-09-24T10:00:01.000Z",
    riskHint: null,
    riskHintBy: null,
    gateRisk: null,
  };
}

describe("alignNegativeRun", () => {
  test("aligns by role and words; returns the last matching step", () => {
    expect(alignNegativeRun([negAction()], STEPS, TARGETS)).toBe("click_search");
  });

  test("null when not even the first step aligns", () => {
    const base = negAction();
    const fingerprint = base.fingerprint;
    if (fingerprint === null) throw new Error("expected a fingerprint");
    const other = { ...base, fingerprint: { ...fingerprint, name: "Cancel" } };
    expect(alignNegativeRun([other], STEPS, TARGETS)).toBeNull();
  });
});

const SPEC = RunSpec.parse({
  schema: "intyy.runspec/1.0",
  kind: "negative_discovery",
  caller: { tenant: "keystone", agent_id: "op_017" },
  app: "kvfcu",
  capability: "open_share_subaccount",
  goal: "Look up a member that does not exist.",
  inputs: [],
  outputs: [],
  expected_effect: "read_only",
  expected_outcome: { code: "member_not_found", description: "No member has this ID" },
  session: null,
  entry: "/home",
  model: "claude-sonnet-5",
  prompt: "discovery@1.0",
});

describe("buildOutcome", () => {
  test("builds the outcome condition from the report_outcome proof text", () => {
    const issues: RecorderIssue[] = [];
    const snapshots: Snapshots = {
      a11yByTurn: new Map(),
      proof: { turn: 3, ids: ["e5"] },
      proofElementListText: 'e5 text "No member found"',
    };
    const registry = new ConditionRegistry();
    const built = buildOutcome(SPEC, "click_search", snapshots, registry, issues);
    expect(issues).toEqual([]);
    expect(built?.stepId).toBe("click_search");
    expect(built?.outcome).toMatchObject({ code: "member_not_found", description: "No member has this ID" });
    const condition = registry.list().find((c) => c.id === built?.outcome.condition);
    expect(condition).toMatchObject({ check: "text_visible", text: "No member found" });
  });

  test("failed alignment is a blocking issue", () => {
    const issues: RecorderIssue[] = [];
    const snapshots: Snapshots = { a11yByTurn: new Map(), proof: null, proofElementListText: null };
    expect(buildOutcome(SPEC, null, snapshots, new ConditionRegistry(), issues)).toBeNull();
    expect(issues).toMatchObject([{ level: "blocking", code: "failed_alignment" }]);
  });
});

describe("attachOutcome", () => {
  test("adds the code to the aligned step only", () => {
    const out = attachOutcome(STEPS, "click_search", "member_not_found");
    expect(out[0]?.outcomes).toEqual(["member_not_found"]);
    expect(STEPS[0]?.outcomes).toEqual([]);
  });
});
