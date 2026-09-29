// Proves every section 2 §19 loader check accepts the design's full example, and rejects a small
// mutation of it. Also proves the candidate/strict split: a fresh candidate's known gaps come
// back `blocking`, and the same file in strict mode comes back `error` (section 6 §14.15,
// docs/decisions.md M04, 2026-09-29).
import { describe, expect, test } from "vitest";
import {
  checkArtifact,
  type ArtifactCheckContext,
} from "../../../src/core/model/artifact-checks.js";
import { Artifact } from "../../../src/core/model/artifact.js";
import { artifactExample } from "../../fixtures/design-examples.js";

/** A deep clone, so each test mutates its own copy. */
function clone(): Record<string, unknown> {
  return structuredClone(artifactExample());
}

/** Parses `doc`, throwing on a schema problem so a broken mutation fails loudly in the test. */
function parse(doc: Record<string, unknown>): Artifact {
  const result = Artifact.safeParse(doc);
  if (!result.success) throw new Error(`fixture mutation broke the schema: ${result.error.message}`);
  return result.data;
}

/** The codes `checkArtifact` reported, in order. */
function codesOf(doc: Record<string, unknown>, context?: ArtifactCheckContext): string[] {
  return checkArtifact(parse(doc), "strict", context).map((p) => p.code);
}

describe("checkArtifact: the accepted case", () => {
  test("the section 2 §21 full example has no problems in strict mode", () => {
    expect(checkArtifact(parse(clone()), "strict")).toEqual([]);
  });
});

describe("checkArtifact: §19.1 format", () => {
  test("rejects a target ID used twice", () => {
    const doc = clone();
    const targets = doc.targets as Record<string, unknown>[];
    targets.push({ ...targets[0] });
    expect(codesOf(doc)).toContain("duplicate_id");
  });
});

describe("checkArtifact: §19.2 references", () => {
  test("rejects a step precondition that names no condition", () => {
    const doc = clone();
    const steps = doc.steps as Record<string, unknown>[];
    const click = steps.find((s) => s.id === "click_login");
    if (click === undefined) throw new Error("fixture missing click_login");
    click.precondition = "no_such_condition";
    expect(codesOf(doc)).toContain("dangling_ref");
  });

  test("rejects two conditions whose `ref`s loop", () => {
    const doc = clone();
    const conditions = doc.conditions as Record<string, unknown>[];
    conditions.push(
      { id: "cycle_a", check: "ref", description: "a", ref: "cycle_b" },
      { id: "cycle_b", check: "ref", description: "b", ref: "cycle_a" },
    );
    expect(codesOf(doc)).toContain("ref_cycle");
  });

  test("rejects an {output.*} reference inside a condition's text (only input, system allowed)", () => {
    const doc = clone();
    const conditions = doc.conditions as Record<string, unknown>[];
    const noMember = conditions.find((c) => c.id === "no_member_text");
    if (noMember === undefined) throw new Error("fixture missing no_member_text");
    noMember.text = "No member found {output.account_number}";
    expect(codesOf(doc)).toContain("bad_namespace");
  });

  test("rejects a {secret.*} reference mixed with other text", () => {
    const doc = clone();
    const steps = doc.steps as Record<string, unknown>[];
    const typeUsername = steps.find((s) => s.id === "type_username");
    if (typeUsername === undefined) throw new Error("fixture missing type_username");
    (typeUsername.action as Record<string, unknown>).value = "prefix {secret.operator_username}";
    expect(codesOf(doc)).toContain("secret_not_whole_value");
  });

  test("rejects a non-wildcard field_value check on a target a secret fills", () => {
    const doc = clone();
    const conditions = doc.conditions as Record<string, unknown>[];
    const usernameFilled = conditions.find((c) => c.id === "username_filled");
    if (usernameFilled === undefined) throw new Error("fixture missing username_filled");
    usernameFilled.value = "someone";
    usernameFilled.match = "exact";
    expect(codesOf(doc)).toContain("secret_field_not_wildcard");
  });
});

describe("checkArtifact: §19.3 outputs and outcomes", () => {
  test("rejects an output no read step writes", () => {
    const doc = clone();
    doc.steps = (doc.steps as Record<string, unknown>[]).filter((s) => s.id !== "read_account_number");
    expect(codesOf(doc)).toContain("output_not_read");
  });

  test("rejects an output two read steps write", () => {
    const doc = clone();
    const steps = doc.steps as Record<string, unknown>[];
    const reader = steps.find((s) => s.id === "read_account_number");
    if (reader === undefined) throw new Error("fixture missing read_account_number");
    steps.push({ ...structuredClone(reader), id: "read_account_number_again" });
    expect(codesOf(doc)).toContain("output_written_twice");
  });

  test("rejects an outcome no step lists", () => {
    const doc = clone();
    (doc.contract as Record<string, unknown>).outcomes = [
      ...((doc.contract as Record<string, unknown>).outcomes as unknown[]),
      { code: "extra_outcome", description: "Never reached", condition: "no_member_text" },
    ];
    expect(codesOf(doc)).toContain("outcome_unused");
  });
});

describe("checkArtifact: §19.4 risk and recovery", () => {
  test("rejects a read_only capability that still has a recovery block", () => {
    const doc = clone();
    (doc.contract as Record<string, unknown>).effect = "read_only";
    expect(codesOf(doc)).toContain("effect_recovery_mismatch");
  });

  test("rejects a commits capability with zero irreversible steps", () => {
    const doc = clone();
    const steps = doc.steps as Record<string, unknown>[];
    const confirm = steps.find((s) => s.id === "click_confirm");
    if (confirm === undefined) throw new Error("fixture missing click_confirm");
    confirm.risk = "idempotent";
    expect(codesOf(doc)).toContain("no_commit_point");
  });

  test("rejects a commit_point that names a different step than the irreversible one", () => {
    const doc = clone();
    (doc.recovery as Record<string, unknown>).commit_point = "click_search";
    expect(codesOf(doc)).toContain("commit_point_mismatch");
  });

  test("rejects a reconciliation block with neither a check nor a waiver", () => {
    const doc = clone();
    (doc.recovery as Record<string, unknown>).reconciliation = {};
    expect(codesOf(doc)).toContain("reconciliation_shape");
  });

  test("rejects a reconciliation capability the context says is not read_only", () => {
    const doc = clone();
    const context: ArtifactCheckContext = {
      resolveCapability: () => ({ effect: "commits", inputs: [], outputs: [], session: null }),
    };
    expect(codesOf(doc, context)).toContain("reconciliation_not_readonly");
  });

  test("rejects a compensated_by capability the context says is not commits", () => {
    const doc = clone();
    const context: ArtifactCheckContext = {
      resolveCapability: (link) =>
        link.includes("close_account")
          ? { effect: "read_only", inputs: [], outputs: [], session: null }
          : { effect: "read_only", inputs: [], outputs: ["account_number"], session: null },
    };
    expect(codesOf(doc, context)).toContain("compensated_by_not_commits");
  });

  test("rejects a commit step outcome with no refusal decision", () => {
    const doc = clone();
    const steps = doc.steps as Record<string, unknown>[];
    const confirm = steps.find((s) => s.id === "click_confirm");
    if (confirm === undefined) throw new Error("fixture missing click_confirm");
    confirm.outcomes = ["member_not_found"];
    expect(codesOf(doc)).toContain("missing_refusal");
  });
});

describe("checkArtifact: §19.5, §19.6 portability and policy", () => {
  test("rejects an entry that matches no pattern in runs_on.paths", () => {
    const doc = clone();
    (doc.runs_on as Record<string, unknown>).entry = "/not-allowed";
    expect(codesOf(doc)).toContain("location_not_in_paths");
  });

  test("rejects a runs_on.paths pattern the policy context denies", () => {
    const doc = clone();
    const context: ArtifactCheckContext = { pathAllowed: () => false };
    expect(codesOf(doc, context)).toContain("policy_path_denied");
  });

  test("rejects a secret the policy context does not declare", () => {
    const doc = clone();
    const context: ArtifactCheckContext = { secretDeclared: () => false };
    expect(codesOf(doc, context)).toContain("policy_secret_undeclared");
  });
});

describe("checkArtifact: §19.7 session link", () => {
  test("rejects a session link the context says is not a valid session capability", () => {
    const doc = clone();
    (doc.runs_on as Record<string, unknown>).session = "kvfcu/sign_in@1";
    const context: ArtifactCheckContext = {
      resolveCapability: () => ({ effect: "commits", inputs: [], outputs: [], session: null }),
    };
    expect(codesOf(doc, context)).toContain("session_link_invalid");
  });
});

describe("checkArtifact: §19.8 formats", () => {
  function withDateRead(doc: Record<string, unknown>, format?: string): void {
    (doc.contract as Record<string, unknown>).outputs = [
      ...((doc.contract as Record<string, unknown>).outputs as unknown[]),
      { name: "opened_on", type: "date", description: "When the account opened", sensitivity: "none" },
    ];
    const steps = doc.steps as Record<string, unknown>[];
    steps.push({
      id: "read_opened_on",
      intent: "Read the opening date",
      action: {
        type: "read",
        target: "confirmation_message",
        source: "text",
        output: "opened_on",
        ...(format === undefined ? {} : { format }),
      },
      precondition: "confirmation_shown",
      checkpoint: "confirmation_shown",
      outcomes: [],
      risk: "idempotent",
      timeout_ms: 5000,
    });
  }

  test("rejects a read step for a date output with no format", () => {
    const doc = clone();
    withDateRead(doc);
    expect(codesOf(doc)).toContain("date_read_needs_format");
  });

  test("rejects a format the policy context's list does not name", () => {
    const doc = clone();
    withDateRead(doc, "YYYY-MM-DD");
    const context: ArtifactCheckContext = { formatsFor: () => ["MM/DD/YYYY"] };
    expect(codesOf(doc, context)).toContain("format_not_listed");
  });
});

describe("checkArtifact: candidate placeholders (section 2 §19.9, section 6 §14.15)", () => {
  test("rejects a null version", () => {
    const doc = clone();
    (doc.identity as Record<string, unknown>).version = null;
    expect(codesOf(doc)).toContain("null_version");
  });

  test("rejects a null seal", () => {
    const doc = clone();
    (doc.provenance as Record<string, unknown>).sealed = null;
    expect(codesOf(doc)).toContain("null_sealed");
  });

  test("rejects an empty about field", () => {
    const doc = clone();
    (doc.about as Record<string, unknown>).title = "";
    expect(codesOf(doc)).toContain("empty_about");
  });

  test("rejects an action with no human tag yet", () => {
    const doc = clone();
    const actions = (doc.provenance as Record<string, unknown>).actions as Record<string, unknown>[];
    const first = actions[0];
    if (first === undefined) throw new Error("fixture has no actions");
    first.human_tag = null;
    first.decided_by = null;
    expect(codesOf(doc)).toContain("undecided_tag");
  });
});

describe("checkArtifact: candidate mode vs strict mode", () => {
  /** The candidate-shaped mutation of tests/unit/model/artifact.test.ts, reused here. */
  function freshCandidate(): Record<string, unknown> {
    const doc = clone();
    (doc.identity as Record<string, unknown>).version = null;
    doc.about = { title: "", summary: "", when_to_use: "", limits: "" };
    const recovery = doc.recovery as Record<string, unknown>;
    recovery.reconciliation = null;
    recovery.commit_point = null;
    (doc.provenance as Record<string, unknown>).sealed = null;
    const actions = (doc.provenance as Record<string, unknown>).actions as Record<string, unknown>[];
    for (const action of actions) {
      action.human_tag = null;
      action.decided_by = null;
    }
    return doc;
  }

  test("a fresh candidate gives blocking issues, never errors", () => {
    const problems = checkArtifact(parse(freshCandidate()), "candidate");
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.level === "blocking")).toBe(true);
    expect(problems.map((p) => p.code)).toEqual(
      expect.arrayContaining(["null_version", "null_sealed", "empty_about", "missing_reconciliation", "no_commit_point", "undecided_tag"]),
    );
  });

  test("the same fresh candidate in strict mode gives errors, never blocking issues", () => {
    const problems = checkArtifact(parse(freshCandidate()), "strict");
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.level === "error")).toBe(true);
  });

  test("a read_only candidate with an irreversible draft step is blocking, not an error", () => {
    // Why: an unsure step drafts as irreversible (section 4 §2.3); a human lowers it with a
    // `risk` decision, so a fresh candidate can start here without being a hard failure.
    const doc = clone();
    (doc.contract as Record<string, unknown>).effect = "read_only";
    const onSteps = (p: { code: string; path: string }) =>
      p.code === "effect_recovery_mismatch" && p.path === "steps";
    expect(checkArtifact(parse(doc), "candidate").find(onSteps)?.level).toBe("blocking");
    expect(checkArtifact(parse(doc), "strict").find(onSteps)?.level).toBe("error");
  });
});
