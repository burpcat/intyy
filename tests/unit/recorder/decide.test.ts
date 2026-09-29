// Proves decide.ts (section 6 §15): every decision kind, applied deterministically, last
// decision per subject wins.
import { describe, expect, test } from "vitest";
import { artifactExample } from "../../fixtures/design-examples.js";
import { Artifact } from "../../../src/core/model/artifact.js";
import type { CandidateDecision } from "../../../src/core/model/candidate-decision.js";
import {
  applyEditDecisions,
  applyOutcomeNameDecisions,
  applyRecoveryDecisions,
  applyRiskDecisions,
  applySensitivityDecisions,
} from "../../../src/core/recorder/decide.js";
import type { RecorderIssue } from "../../../src/core/recorder/issues.js";

/** One decision line, with sane defaults. */
function decision(partial: Partial<CandidateDecision> & Pick<CandidateDecision, "what" | "subject" | "value">): CandidateDecision {
  return {
    schema: "intyy.candidate_decision/1.0",
    by: "op_017",
    at: "2026-09-24T14:00:00Z",
    ...partial,
  };
}

function baseArtifact(): Artifact {
  return Artifact.parse(artifactExample());
}

describe("applyRiskDecisions", () => {
  test("a lowering from the rules' irreversible class needs a second look by another staff ID", () => {
    const steps = [
      { id: "click_confirm", intent: "x", action: { type: "click" as const, target: "confirm_button" }, precondition: "p", checkpoint: "c", outcomes: [], risk: "irreversible" as const, timeout_ms: 15000 },
    ];
    const decisions = [decision({ what: "risk", subject: "click_confirm", value: "idempotent", by: "op_017" })];
    const issues: RecorderIssue[] = [];
    const out = applyRiskDecisions(steps, decisions, new Map([["click_confirm", "irreversible"]]), new Map(), issues);
    expect(out[0]?.risk).toBe("idempotent");
    expect(issues).toMatchObject([{ level: "blocking", code: "risk_second_look", subject: "click_confirm" }]);
  });

  test("a risk_second_look by a different staff ID clears the issue", () => {
    const steps = [
      { id: "click_confirm", intent: "x", action: { type: "click" as const, target: "confirm_button" }, precondition: "p", checkpoint: "c", outcomes: [], risk: "irreversible" as const, timeout_ms: 15000 },
    ];
    const decisions = [
      decision({ what: "risk", subject: "click_confirm", value: "idempotent", by: "op_017" }),
      decision({ what: "risk_second_look", subject: "click_confirm", value: "idempotent", by: "op_022" }),
    ];
    const issues: RecorderIssue[] = [];
    applyRiskDecisions(steps, decisions, new Map([["click_confirm", "irreversible"]]), new Map(), issues);
    expect(issues).toEqual([]);
  });

  test("a disagreeing second reviewer's own risk decision wins, and needs no second look", () => {
    const steps = [
      { id: "click_confirm", intent: "x", action: { type: "click" as const, target: "confirm_button" }, precondition: "p", checkpoint: "c", outcomes: [], risk: "irreversible" as const, timeout_ms: 15000 },
    ];
    const decisions = [
      decision({ what: "risk", subject: "click_confirm", value: "idempotent", by: "op_017" }),
      decision({ what: "risk", subject: "click_confirm", value: "irreversible", by: "op_022" }),
    ];
    const issues: RecorderIssue[] = [];
    const out = applyRiskDecisions(steps, decisions, new Map([["click_confirm", "irreversible"]]), new Map(), issues);
    expect(out[0]?.risk).toBe("irreversible");
    expect(issues).toEqual([]);
  });
});

describe("applySensitivityDecisions", () => {
  test("overrides a named input's or output's label", () => {
    const artifact = baseArtifact();
    const decisions = [decision({ what: "sensitivity", subject: "account_number", value: "pii" })];
    const out = applySensitivityDecisions(artifact.contract, decisions);
    expect(out.outputs.find((o) => o.name === "account_number")?.sensitivity).toBe("pii");
  });
});

describe("applyOutcomeNameDecisions", () => {
  test("renames an outcome's code on the contract and its step", () => {
    const artifact = baseArtifact();
    const decisions = [decision({ what: "outcome_name", subject: "member_not_found", value: "no_such_member" })];
    const { outcomes, steps } = applyOutcomeNameDecisions(artifact.contract.outcomes, artifact.steps, decisions);
    expect(outcomes.find((o) => o.code === "no_such_member")).toBeDefined();
    const search = steps.find((s) => s.id === "click_search");
    expect(search?.outcomes).toEqual(["no_such_member"]);
  });
});

describe("applyRecoveryDecisions", () => {
  const recovery = { commit_point: "click_confirm", reconciliation: null };

  test("a waiver decision fills in the waiver", () => {
    const decisions = [decision({ what: "waiver", subject: "recovery.reconciliation", value: JSON.stringify({ reason: "No check screen exists." }) })];
    const issues: RecorderIssue[] = [];
    const out = applyRecoveryDecisions(recovery, decisions, issues);
    expect(out?.reconciliation).toEqual({ waiver: { reason: "No check screen exists." } });
    expect(issues).toEqual([]);
  });

  test("a recovery decision fills in the reconciliation link", () => {
    const value = JSON.stringify({
      capability: "kvfcu/find_account_by_reference@1",
      inputs: { member_id: "{input.member_id}" },
    });
    const decisions = [decision({ what: "recovery", subject: "recovery.reconciliation", value })];
    const out = applyRecoveryDecisions(recovery, decisions, []);
    expect(out?.reconciliation).toMatchObject({
      check: { capability: "kvfcu/find_account_by_reference@1", not_found_outcomes: [], outputs: {} },
    });
  });

  test("a value that will not parse is a blocking issue, and recovery is unchanged", () => {
    const decisions = [decision({ what: "waiver", subject: "recovery.reconciliation", value: "not json" })];
    const issues: RecorderIssue[] = [];
    const out = applyRecoveryDecisions(recovery, decisions, issues);
    expect(out).toBe(recovery);
    expect(issues).toMatchObject([{ level: "blocking", code: "invalid_recovery_decision" }]);
  });
});

describe("applyEditDecisions", () => {
  test("edits a plain field", () => {
    const artifact = baseArtifact();
    const decisions = [decision({ what: "edit", subject: "about.when_to_use", value: "Use when opening a share account." })];
    const out = applyEditDecisions(artifact, decisions, []);
    expect(out.about.when_to_use).toBe("Use when opening a share account.");
  });

  test("a rename updates every reference to the old ID", () => {
    const artifact = baseArtifact();
    const decisions = [decision({ what: "edit", subject: "targets.search_button.id", value: "find_button" })];
    const issues: RecorderIssue[] = [];
    const out = applyEditDecisions(artifact, decisions, issues);
    expect(issues).toEqual([]);
    expect(out.targets.some((t) => t.id === "find_button")).toBe(true);
    const step = out.steps.find((s) => s.id === "click_search");
    expect(step?.action).toMatchObject({ target: "find_button" });
  });

  test("an edit that would produce an invalid artifact is a blocking issue, not a throw", () => {
    const artifact = baseArtifact();
    const decisions = [decision({ what: "edit", subject: "steps.click_search.timeout_ms", value: "not a number" })];
    const issues: RecorderIssue[] = [];
    const out = applyEditDecisions(artifact, decisions, issues);
    expect(out).toEqual(artifact);
    expect(issues).toMatchObject([{ level: "blocking", code: "invalid_edit" }]);
  });
});
