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
  test("checkArtifact rejects bad references in conditions, text, and secret fills", () => {
    // rejects a step precondition that names no condition
    {
      const doc = clone();
      const steps = doc.steps as Record<string, unknown>[];
      const click = steps.find((s) => s.id === "click_login");
      if (click === undefined) throw new Error("fixture missing click_login");
      click.precondition = "no_such_condition";
      expect(codesOf(doc)).toContain("dangling_ref");
    }
    // rejects two conditions whose `ref`s loop
    {
      const doc = clone();
      const conditions = doc.conditions as Record<string, unknown>[];
      conditions.push(
        { id: "cycle_a", check: "ref", description: "a", ref: "cycle_b" },
        { id: "cycle_b", check: "ref", description: "b", ref: "cycle_a" },
      );
      expect(codesOf(doc)).toContain("ref_cycle");
    }
    // rejects an {output.*} reference inside a condition's text (only input, system allowed)
    {
      const doc = clone();
      const conditions = doc.conditions as Record<string, unknown>[];
      const noMember = conditions.find((c) => c.id === "no_member_text");
      if (noMember === undefined) throw new Error("fixture missing no_member_text");
      noMember.text = "No member found {output.account_number}";
      expect(codesOf(doc)).toContain("bad_namespace");
    }
    // rejects a {secret.*} reference mixed with other text
    {
      const doc = clone();
      const steps = doc.steps as Record<string, unknown>[];
      const typeUsername = steps.find((s) => s.id === "type_username");
      if (typeUsername === undefined) throw new Error("fixture missing type_username");
      (typeUsername.action as Record<string, unknown>).value = "prefix {secret.operator_username}";
      expect(codesOf(doc)).toContain("secret_not_whole_value");
    }
    // rejects a non-wildcard field_value check on a target a secret fills
    {
      const doc = clone();
      const conditions = doc.conditions as Record<string, unknown>[];
      const usernameFilled = conditions.find((c) => c.id === "username_filled");
      if (usernameFilled === undefined) throw new Error("fixture missing username_filled");
      usernameFilled.value = "someone";
      usernameFilled.match = "exact";
      expect(codesOf(doc)).toContain("secret_field_not_wildcard");
    }
  });
});

describe("checkArtifact: §19.3 outputs and outcomes", () => {
  test("checkArtifact rejects outputs and outcomes with no single writer or listing step", () => {
    // rejects an output no read step writes
    {
      const doc = clone();
      doc.steps = (doc.steps as Record<string, unknown>[]).filter((s) => s.id !== "read_account_number");
      expect(codesOf(doc)).toContain("output_not_read");
    }
    // rejects an output two read steps write
    {
      const doc = clone();
      const steps = doc.steps as Record<string, unknown>[];
      const reader = steps.find((s) => s.id === "read_account_number");
      if (reader === undefined) throw new Error("fixture missing read_account_number");
      steps.push({ ...structuredClone(reader), id: "read_account_number_again" });
      expect(codesOf(doc)).toContain("output_written_twice");
    }
    // rejects an outcome no step lists
    {
      const doc = clone();
      (doc.contract as Record<string, unknown>).outcomes = [
        ...((doc.contract as Record<string, unknown>).outcomes as unknown[]),
        { code: "extra_outcome", description: "Never reached", condition: "no_member_text" },
      ];
      expect(codesOf(doc)).toContain("outcome_unused");
    }
  });
});

describe("checkArtifact: §19.4 risk and recovery", () => {
  test("checkArtifact rejects bad risk, recovery, reconciliation, and refusal declarations", () => {
    // rejects a read_only capability that still has a recovery block
    {
      const doc = clone();
      (doc.contract as Record<string, unknown>).effect = "read_only";
      expect(codesOf(doc)).toContain("effect_recovery_mismatch");
    }
    // rejects a commits capability with zero irreversible steps
    {
      const doc = clone();
      const steps = doc.steps as Record<string, unknown>[];
      const confirm = steps.find((s) => s.id === "click_confirm");
      if (confirm === undefined) throw new Error("fixture missing click_confirm");
      confirm.risk = "idempotent";
      expect(codesOf(doc)).toContain("no_commit_point");
    }
    // rejects a commit_point that names a different step than the irreversible one
    {
      const doc = clone();
      (doc.recovery as Record<string, unknown>).commit_point = "click_search";
      expect(codesOf(doc)).toContain("commit_point_mismatch");
    }
    // rejects a reconciliation block with neither a check nor a waiver
    {
      const doc = clone();
      (doc.recovery as Record<string, unknown>).reconciliation = {};
      expect(codesOf(doc)).toContain("reconciliation_shape");
    }
    // rejects a reconciliation capability the context says is not read_only
    {
      const doc = clone();
      const context: ArtifactCheckContext = {
        resolveCapability: () => ({ effect: "commits", inputs: [], outputs: [], session: null }),
      };
      expect(codesOf(doc, context)).toContain("reconciliation_not_readonly");
    }
    // rejects a compensated_by capability the context says is not commits
    {
      const doc = clone();
      const context: ArtifactCheckContext = {
        resolveCapability: (link) =>
          link.includes("close_account")
            ? { effect: "read_only", inputs: [], outputs: [], session: null }
            : { effect: "read_only", inputs: [], outputs: ["account_number"], session: null },
      };
      expect(codesOf(doc, context)).toContain("compensated_by_not_commits");
    }
    // rejects a commit step outcome with no refusal decision
    {
      const doc = clone();
      const steps = doc.steps as Record<string, unknown>[];
      const confirm = steps.find((s) => s.id === "click_confirm");
      if (confirm === undefined) throw new Error("fixture missing click_confirm");
      confirm.outcomes = ["member_not_found"];
      expect(codesOf(doc)).toContain("missing_refusal");
    }
  });
});

describe("checkArtifact: §19.4 the reconciliation check is a sealed capability (owner decisions, 2026-10-01)", () => {
  const COUNT_LINK = "kvfcu/count_member_subaccounts@1";
  /** The example with a `count_diff` check named `countOutput`. */
  function countDiffDoc(countOutput = "subaccount_count"): Record<string, unknown> {
    const doc = clone();
    (doc.recovery as Record<string, unknown>).reconciliation = {
      check: { capability: COUNT_LINK, mode: "count_diff", count_output: countOutput, inputs: { member_id: "{input.member_id}" }, not_found_outcomes: [], outputs: {} },
    };
    return doc;
  }
  /** A context where `COUNT_LINK` is `check`, and any other link (the compensation) is a sealed committing capability. */
  function contextWith(check: ReturnType<NonNullable<ArtifactCheckContext["resolveCapability"]>>): ArtifactCheckContext {
    return {
      resolveCapability: (link) => (link === COUNT_LINK ? check : { effect: "commits", inputs: [], outputs: [], session: null }),
    };
  }
  const countShape = (outputTypes?: Record<string, string>) => ({
    effect: "read_only" as const,
    inputs: ["member_id"],
    outputs: ["subaccount_count"],
    ...(outputTypes === undefined ? {} : { outputTypes }),
    session: null,
  });
  /** Only the reconciliation codes, so unrelated example gaps cannot hide or fake a pass. */
  const reconCodes = (doc: Record<string, unknown>, context: ArtifactCheckContext, mode: "strict" | "candidate" = "strict") =>
    checkArtifact(parse(doc), mode, context).filter((p) => p.code.startsWith("reconciliation_"));

  test("checkArtifact checks the reconciliation check capability by seal, shape, and mode", () => {
    // a sealed read_only check with an integer count_output has no reconciliation issue
    expect(reconCodes(countDiffDoc(), contextWith(countShape({ subaccount_count: "integer" })))).toEqual([]);
    // a count_output that is not an output of the check capability is reconciliation_count_shape
    {
      const found = reconCodes(countDiffDoc("other"), contextWith(countShape({ subaccount_count: "integer" })));
      expect(found.map((p) => p.code)).toEqual(["reconciliation_count_shape"]);
      expect(found[0]?.message).toContain("other");
    }
    // a count_output typed string is reconciliation_count_shape
    {
      const found = reconCodes(countDiffDoc(), contextWith(countShape({ subaccount_count: "string" })));
      expect(found.map((p) => p.code)).toEqual(["reconciliation_count_shape"]);
    }
    // with no output types known, only the name is checked
    expect(reconCodes(countDiffDoc(), contextWith(countShape()))).toEqual([]);
    expect(reconCodes(countDiffDoc("other"), contextWith(countShape())).map((p) => p.code)).toEqual(["reconciliation_count_shape"]);
    // a check capability that is not sealed is an error in strict mode, naming the link and the fix
    {
      const found = reconCodes(countDiffDoc(), contextWith(undefined));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ code: "reconciliation_not_readonly", level: "error" });
      expect(found[0]?.message).toContain(COUNT_LINK);
      expect(found[0]?.message).toContain("seal the check capability first");
    }
    // the same unsealed check is blocking, not an error, in candidate mode
    {
      const found = reconCodes(countDiffDoc(), contextWith(undefined), "candidate");
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ code: "reconciliation_not_readonly", level: "blocking" });
    }
    // a sealed check that commits keeps the old message
    {
      const found = reconCodes(countDiffDoc(), contextWith({ ...countShape({ subaccount_count: "integer" }), effect: "commits" }));
      expect(found).toHaveLength(1);
      expect(found[0]?.message).toBe("the reconciliation capability must be read_only");
    }
    // a reference-mode check that is not sealed is also refused
    {
      const context: ArtifactCheckContext = { resolveCapability: (link) => (link.includes("find_account") ? undefined : { effect: "commits", inputs: [], outputs: [], session: null }) };
      expect(reconCodes(clone(), context).map((p) => p.code)).toEqual(["reconciliation_not_readonly"]);
    }
    // with no resolver at all (a context without resolveCapability), no link check runs
    expect(reconCodes(countDiffDoc(), {})).toEqual([]);
  });
});

describe("checkArtifact: §19.5, §19.6 portability and policy", () => {
  test("checkArtifact rejects entries and secrets the policy denies", () => {
    // rejects an entry that matches no pattern in runs_on.paths
    {
      const doc = clone();
      (doc.runs_on as Record<string, unknown>).entry = "/not-allowed";
      expect(codesOf(doc)).toContain("location_not_in_paths");
    }
    // rejects a runs_on.paths pattern the policy context denies
    {
      const doc = clone();
      const context: ArtifactCheckContext = { pathAllowed: () => false };
      expect(codesOf(doc, context)).toContain("policy_path_denied");
    }
    // rejects a secret the policy context does not declare
    {
      const doc = clone();
      const context: ArtifactCheckContext = { secretDeclared: () => false };
      expect(codesOf(doc, context)).toContain("policy_secret_undeclared");
    }
  });
});

describe("checkArtifact: §19.7 session link", () => {
  test("checkArtifact checks the session link capability", () => {
    // rejects a session link the context says is not a valid session capability
    {
      const doc = clone();
      (doc.runs_on as Record<string, unknown>).session = "kvfcu/sign_in@1";
      const context: ArtifactCheckContext = {
        resolveCapability: () => ({ effect: "commits", inputs: [], outputs: [], session: null }),
      };
      expect(codesOf(doc, context)).toContain("session_link_invalid");
    }
    // rejects a session link whose capability is not sealed at all (real seals now supply the resolver)
    {
      const doc = clone();
      (doc.runs_on as Record<string, unknown>).session = "kvfcu/sign_in@1";
      const context: ArtifactCheckContext = { resolveCapability: () => undefined };
      expect(codesOf(doc, context)).toContain("session_link_invalid");
    }
    // accepts a session link whose capability is sealed as a session (read_only, no session of its own)
    {
      const doc = clone();
      (doc.runs_on as Record<string, unknown>).session = "kvfcu/sign_in@1";
      const context: ArtifactCheckContext = {
        resolveCapability: (link) =>
          link === "kvfcu/sign_in@1"
            ? { effect: "read_only", inputs: [], outputs: [], session: null }
            : { effect: link.includes("close_account") ? "commits" : "read_only", inputs: [], outputs: ["account_number"], session: null },
      };
      expect(codesOf(doc, context)).not.toContain("session_link_invalid");
    }
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

  test("checkArtifact rejects missing or unlisted formats", () => {
    // rejects a read step for a date output with no format
    {
      const doc = clone();
      withDateRead(doc);
      expect(codesOf(doc)).toContain("date_read_needs_format");
    }
    // rejects a format the policy context's list does not name
    {
      const doc = clone();
      withDateRead(doc, "YYYY-MM-DD");
      const context: ArtifactCheckContext = { formatsFor: () => ["MM/DD/YYYY"] };
      expect(codesOf(doc, context)).toContain("format_not_listed");
    }
  });
});

describe("checkArtifact: candidate placeholders (section 2 §19.9, section 6 §14.15)", () => {
  test("checkArtifact rejects candidate placeholders left empty", () => {
    // rejects a null version
    {
      const doc = clone();
      (doc.identity as Record<string, unknown>).version = null;
      expect(codesOf(doc)).toContain("null_version");
    }
    // rejects a null seal
    {
      const doc = clone();
      (doc.provenance as Record<string, unknown>).sealed = null;
      expect(codesOf(doc)).toContain("null_sealed");
    }
    // rejects an empty about field
    {
      const doc = clone();
      (doc.about as Record<string, unknown>).title = "";
      expect(codesOf(doc)).toContain("empty_about");
    }
    // rejects an action with no human tag yet
    {
      const doc = clone();
      const actions = (doc.provenance as Record<string, unknown>).actions as Record<string, unknown>[];
      const first = actions[0];
      if (first === undefined) throw new Error("fixture has no actions");
      first.human_tag = null;
      first.decided_by = null;
      expect(codesOf(doc)).toContain("undecided_tag");
    }
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

  test("checkArtifact gives blocking issues in candidate mode and errors in strict mode", () => {
    // a fresh candidate gives blocking issues, never errors
    {
      const problems = checkArtifact(parse(freshCandidate()), "candidate");
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.every((p) => p.level === "blocking")).toBe(true);
      expect(problems.map((p) => p.code)).toEqual(
        expect.arrayContaining(["null_version", "null_sealed", "empty_about", "missing_reconciliation", "no_commit_point", "undecided_tag"]),
      );
    }
    // the same fresh candidate in strict mode gives errors, never blocking issues
    {
      const problems = checkArtifact(parse(freshCandidate()), "strict");
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.every((p) => p.level === "error")).toBe(true);
    }
    // a read_only candidate with an irreversible draft step is blocking, not an error
    {
      // Why: an unsure step drafts as irreversible (section 4 §2.3); a human lowers it with a
      // `risk` decision, so a fresh candidate can start here without being a hard failure.
      const doc = clone();
      (doc.contract as Record<string, unknown>).effect = "read_only";
      const onSteps = (p: { code: string; path: string }) =>
        p.code === "effect_recovery_mismatch" && p.path === "steps";
      expect(checkArtifact(parse(doc), "candidate").find(onSteps)?.level).toBe("blocking");
      expect(checkArtifact(parse(doc), "strict").find(onSteps)?.level).toBe("error");
    }
  });
});
