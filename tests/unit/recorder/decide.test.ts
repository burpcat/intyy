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
import { ConditionRegistry } from "../../../src/core/recorder/conditions.js";
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
  test("a lowering needs a second look by another staff ID, which clears it; a disagreeing reviewer wins", () => {
    const steps = [
      { id: "click_confirm", intent: "x", action: { type: "click" as const, target: "confirm_button" }, precondition: "p", checkpoint: "c", outcomes: [], risk: "irreversible" as const, timeout_ms: 15000 },
    ];
    const rules = new Map([["click_confirm", "irreversible" as const]]);
    const lowered = decision({ what: "risk", subject: "click_confirm", value: "idempotent", by: "op_017" });

    const lowIssues: RecorderIssue[] = [];
    const low = applyRiskDecisions(steps, [lowered], rules, new Map(), lowIssues);
    expect(low[0]?.risk).toBe("idempotent");
    expect(lowIssues).toMatchObject([{ level: "blocking", code: "risk_second_look", subject: "click_confirm" }]);

    const clearedIssues: RecorderIssue[] = [];
    const secondLook = decision({ what: "risk_second_look", subject: "click_confirm", value: "idempotent", by: "op_022" });
    applyRiskDecisions(steps, [lowered, secondLook], rules, new Map(), clearedIssues);
    expect(clearedIssues).toEqual([]);

    const winIssues: RecorderIssue[] = [];
    const disagree = decision({ what: "risk", subject: "click_confirm", value: "irreversible", by: "op_022" });
    const win = applyRiskDecisions(steps, [lowered, disagree], rules, new Map(), winIssues);
    expect(win[0]?.risk).toBe("irreversible");
    expect(winIssues).toEqual([]);
  });

  test("a step with no risk decision at all is blocking, even when its risk was never lowered", () => {
    // Section 6 §14.9: "Every flag still needs a human risk decision." The approval hint that
    // drafted this idempotent risk is not a review decision.
    const steps = [
      { id: "type_username", intent: "x", action: { type: "click" as const, target: "username_box" }, precondition: "p", checkpoint: "c", outcomes: [], risk: "idempotent" as const, timeout_ms: 5000 },
    ];
    const issues: RecorderIssue[] = [];
    const out = applyRiskDecisions(steps, [], new Map([["type_username", "idempotent"]]), new Map(), issues);
    expect(out[0]?.risk).toBe("idempotent");
    expect(issues).toMatchObject([
      { level: "blocking", code: "risk_undecided", subject: "type_username" },
    ]);
  });

  test("an undecided, lowered flag gets both issues, second look first", () => {
    // No `risk` decision at all: the draft itself is already lowered, by the approval hint
    // that `riskHintByStepId` names (`op_017`).
    const step = {
      id: "click_confirm",
      intent: "x",
      action: { type: "click" as const, target: "confirm_button" },
      precondition: "p",
      checkpoint: "c",
      outcomes: [],
      risk: "idempotent" as const,
      timeout_ms: 15000,
    };
    const issues: RecorderIssue[] = [];
    applyRiskDecisions(
      [step],
      [],
      new Map([["click_confirm", "irreversible"]]),
      new Map([["click_confirm", "op_017"]]),
      issues,
    );
    expect(issues.map((i) => i.code)).toEqual(["risk_second_look", "risk_undecided"]);
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
    const registry = new ConditionRegistry(artifact.conditions);
    const { outcomes, steps } = applyOutcomeNameDecisions(
      artifact.contract.outcomes,
      artifact.steps,
      artifact.targets,
      registry,
      decisions,
      undefined,
      [],
    );
    expect(outcomes.find((o) => o.code === "no_such_member")).toBeDefined();
    const search = steps.find((s) => s.id === "click_search");
    expect(search?.outcomes).toEqual(["no_such_member"]);
  });

  test("a pack: value copies the handler's outcome code, description, and detector condition", () => {
    const artifact = baseArtifact();
    const decisions = [decision({ what: "outcome_name", subject: "member_not_found", value: "pack:member_frozen" })];
    const registry = new ConditionRegistry(artifact.conditions);
    const issues: RecorderIssue[] = [];
    const packTarget = { id: "unfreeze_button", description: "Unfreeze button", clues: { role: "button", name: "Unfreeze" } };
    const packCondition = {
      id: "member_frozen_shown",
      description: "Member is frozen",
      check: "element_visible" as const,
      target: "unfreeze_button",
    };
    const handler = {
      id: "member_frozen",
      description: "The member's account is frozen.",
      class: "business_outcome" as const,
      detector: "member_frozen_shown",
      fixtures: { fire: [], no_fire: [] },
      outcome: { code: "member_frozen", description: "The member's account is frozen." },
    };
    const { outcomes, targets } = applyOutcomeNameDecisions(
      artifact.contract.outcomes,
      artifact.steps,
      artifact.targets,
      registry,
      decisions,
      { targets: [packTarget], conditions: [packCondition], handlers: [handler] },
      issues,
    );
    expect(issues).toEqual([]);
    const adopted = outcomes.find((o) => o.code === "member_frozen");
    expect(adopted?.description).toBe("The member's account is frozen.");
    expect(adopted?.condition).toBeDefined();
    const condition = registry.list().find((c) => c.id === adopted?.condition);
    expect(condition).toMatchObject({ check: "element_visible", target: "unfreeze_button" });
    expect(targets.some((t) => t.id === "unfreeze_button")).toBe(true);
  });

  test("an unresolvable pack: handler is a blocking issue, and the outcome is left unchanged", () => {
    const artifact = baseArtifact();
    const decisions = [decision({ what: "outcome_name", subject: "member_not_found", value: "pack:no_such_handler" })];
    const registry = new ConditionRegistry(artifact.conditions);
    const issues: RecorderIssue[] = [];
    const { outcomes } = applyOutcomeNameDecisions(
      artifact.contract.outcomes,
      artifact.steps,
      artifact.targets,
      registry,
      decisions,
      { targets: [], conditions: [], handlers: [] },
      issues,
    );
    expect(outcomes.find((o) => o.code === "member_not_found")).toBeDefined();
    expect(issues.map((i) => i.code)).toEqual(["pack_outcome_missing"]);
  });

  test("a pack: handler of the wrong class is a blocking issue too, never adopted", () => {
    const artifact = baseArtifact();
    const decisions = [decision({ what: "outcome_name", subject: "member_not_found", value: "pack:kyc_reminder" })];
    const registry = new ConditionRegistry(artifact.conditions);
    const issues: RecorderIssue[] = [];
    // A real handler, just not `business_outcome`: only that class carries an `outcome` block
    // to copy (section 5 §9.2).
    const handler = {
      id: "kyc_reminder",
      description: "The app interrupts with a KYC reminder.",
      class: "recoverable" as const,
      detector: "kyc_popup_shown",
      response: [],
      limits: { per_step: 1, per_run: 1 },
      on_exhausted: { class: "hard_failure" as const, failure: "app_error" as const },
      fixtures: { fire: [], no_fire: [] },
    };
    const { outcomes } = applyOutcomeNameDecisions(
      artifact.contract.outcomes,
      artifact.steps,
      artifact.targets,
      registry,
      decisions,
      { targets: [], conditions: [], handlers: [handler] },
      issues,
    );
    expect(outcomes.find((o) => o.code === "member_not_found")).toBeDefined();
    expect(issues.map((i) => i.code)).toEqual(["pack_outcome_missing"]);
  });
});

describe("applyRecoveryDecisions", () => {
  const recovery = { commit_point: "click_confirm", reconciliation: null };

  test("a waiver or recovery decision fills in the reconciliation, and a link's mode defaults to reference", () => {
    const waiverIssues: RecorderIssue[] = [];
    const waived = applyRecoveryDecisions(
      recovery,
      [decision({ what: "waiver", subject: "recovery.reconciliation", value: JSON.stringify({ reason: "No check screen exists.", attempt_run: "run_2026-10-01_0123456789" }) })],
      waiverIssues,
    );
    expect(waived?.reconciliation).toEqual({ waiver: { reason: "No check screen exists.", attempt_run: "run_2026-10-01_0123456789" } });
    expect(waiverIssues).toEqual([]);

    const value = JSON.stringify({
      capability: "kvfcu/find_account_by_reference@1",
      inputs: { member_id: "{input.member_id}" },
    });
    const linked = applyRecoveryDecisions(recovery, [decision({ what: "recovery", subject: "recovery.reconciliation", value })], []);
    expect(linked?.reconciliation).toMatchObject({
      check: { capability: "kvfcu/find_account_by_reference@1", not_found_outcomes: [], outputs: {} },
    });
    expect(linked?.reconciliation).toMatchObject({ check: { mode: "reference" } });

    const diffValue = JSON.stringify({
      capability: "kvfcu/count_member_subaccounts@1",
      mode: "count_diff",
      count_output: "sub_account_count",
      inputs: { member_id: "{input.member_id}" },
    });
    const issues: RecorderIssue[] = [];
    const diffed = applyRecoveryDecisions(recovery, [decision({ what: "recovery", subject: "recovery.reconciliation", value: diffValue })], issues);
    expect(diffed?.reconciliation).toMatchObject({ check: { mode: "count_diff", count_output: "sub_account_count" } });
    expect(issues).toEqual([]);
  });

  test("an invalid recovery decision is a blocking issue, and recovery is unchanged", () => {
    const badValues: [string, string, string][] = [
      ["a waiver without attempt_run", "waiver", JSON.stringify({ reason: "No check screen exists." })],
      [
        "an unknown mode",
        "recovery",
        JSON.stringify({ capability: "kvfcu/count_member_subaccounts@1", mode: "bogus", inputs: {} }),
      ],
      ["a value that will not parse", "waiver", "not json"],
    ];
    for (const [name, what, value] of badValues) {
      const issues: RecorderIssue[] = [];
      const out = applyRecoveryDecisions(
        recovery,
        [decision({ what: what as "waiver" | "recovery", subject: "recovery.reconciliation", value })],
        issues,
      );
      expect(out, name).toBe(recovery);
      expect(issues, name).toMatchObject([{ level: "blocking", code: "invalid_recovery_decision" }]);
    }
  });
});

describe("applyEditDecisions", () => {
  test("edits a plain field, renames with every reference, and replaces paths", () => {
    const artifact = baseArtifact();
    const plain = applyEditDecisions(
      artifact,
      [decision({ what: "edit", subject: "about.when_to_use", value: "Use when opening a share account." })],
      [],
    );
    expect(plain.about.when_to_use).toBe("Use when opening a share account.");

    const renameIssues: RecorderIssue[] = [];
    const renamed = applyEditDecisions(
      artifact,
      [decision({ what: "edit", subject: "targets.search_button.id", value: "find_button" })],
      renameIssues,
    );
    expect(renameIssues).toEqual([]);
    expect(renamed.targets.some((t) => t.id === "find_button")).toBe(true);
    expect(renamed.steps.find((s) => s.id === "click_search")?.action).toMatchObject({ target: "find_button" });

    const pathIssues: RecorderIssue[] = [];
    const paths = applyEditDecisions(
      artifact,
      [decision({ what: "edit", subject: "runs_on.paths", value: JSON.stringify(["/login", "/home"]) })],
      pathIssues,
    );
    expect(pathIssues).toEqual([]);
    expect(paths.runs_on.paths).toEqual(["/login", "/home"]);
  });

  test("an edit that would produce an invalid artifact is a blocking issue, not a throw", () => {
    const artifact = baseArtifact();
    const decisions = [decision({ what: "edit", subject: "steps.click_search.timeout_ms", value: "not a number" })];
    const issues: RecorderIssue[] = [];
    const out = applyEditDecisions(artifact, decisions, issues);
    expect(out).toEqual(artifact);
    expect(issues).toMatchObject([{ level: "blocking", code: "invalid_edit" }]);
  });

  test("runs_on.paths with bad JSON or a bad path pattern is a blocking invalid_edit, candidate unchanged", () => {
    const bad: [string, string][] = [
      ["bad JSON", "not json"],
      ["a pattern that fails the path-pattern parse", JSON.stringify(["home"])],
    ];
    for (const [name, value] of bad) {
      const artifact = baseArtifact();
      const issues: RecorderIssue[] = [];
      const out = applyEditDecisions(artifact, [decision({ what: "edit", subject: "runs_on.paths", value })], issues);
      expect(out, name).toEqual(artifact);
      expect(issues, name).toMatchObject([{ level: "blocking", code: "invalid_edit", subject: "runs_on.paths" }]);
    }
  });

  test("conditions.<id> replaces a condition's check, keeping its id and description", () => {
    const artifact = baseArtifact();
    const decisions = [
      decision({
        what: "edit",
        subject: "conditions.home_page_shown",
        value: JSON.stringify({ check: "location", pattern: "/home" }),
      }),
    ];
    const issues: RecorderIssue[] = [];
    const out = applyEditDecisions(artifact, decisions, issues);
    expect(issues).toEqual([]);
    const edited = out.conditions.find((c) => c.id === "home_page_shown");
    expect(edited).toMatchObject({
      check: "location",
      pattern: "/home",
      description: artifact.conditions.find((c) => c.id === "home_page_shown")?.description,
    });
  });

  test("conditions.<id> with bad JSON, a missing target, or an unknown condition is a blocking invalid_edit", () => {
    const cases: [string, string, string][] = [
      ["bad JSON", "conditions.home_page_shown", "not json"],
      [
        "a target that does not exist",
        "conditions.home_page_shown",
        JSON.stringify({ check: "element_visible", target: "no_such_target" }),
      ],
      [
        "an unknown condition",
        "conditions.no_such_condition",
        JSON.stringify({ check: "location", pattern: "/home" }),
      ],
    ];
    for (const [name, subject, value] of cases) {
      const artifact = baseArtifact();
      const issues: RecorderIssue[] = [];
      const out = applyEditDecisions(artifact, [decision({ what: "edit", subject, value })], issues);
      expect(out, name).toEqual(artifact);
      expect(issues, name).toMatchObject([{ level: "blocking", code: "invalid_edit", subject }]);
    }
  });
});
