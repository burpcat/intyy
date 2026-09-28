// Proves the run spec checks: bad example values and missing fields are rejected before a browser
// opens. Design section 6 §6, §7.2, §18 ("Run spec checks"); section 2 §12.3, §12.4.
import { describe, expect, test } from "vitest";
import { RunSpec } from "../../../src/core/model/runspec.js";
import { checkSpec, type SpecFacts } from "../../../src/core/discovery/spec-checks.js";

/** Section 6 §6.3's example spec. Member 100142 exists in CONTRACT §5 and is not the canary. */
function example(): Record<string, unknown> {
  return {
    schema: "intyy.runspec/1.0",
    kind: "discovery",
    caller: { tenant: "keystone", agent_id: "op_017" },
    app: "kvfcu",
    capability: "open_share_subaccount",
    goal: "Open a new share sub-account for member {input.member_id} with an opening deposit of {input.deposit}. Return the new account number.",
    inputs: [
      {
        name: "member_id",
        type: "string",
        description: "The member number",
        sensitivity: "pii",
        example: "100142",
        constraints: { format: "digits", length: { min: 6, max: 6 } },
      },
      {
        name: "deposit",
        type: "money",
        description: "Opening deposit",
        sensitivity: "financial",
        example: "137.00",
      },
    ],
    outputs: [
      { name: "account_number", type: "string", description: "The new sub-account number" },
    ],
    expected_effect: "commits",
    correlation: "notes",
    session: "kvfcu/sign_in@1",
    entry: "/home",
    limits: { max_steps: 40 },
    model: "claude-sonnet-5",
    prompt: "discovery@1.0",
    derived_from: null,
  };
}

const FACTS: SpecFacts = {
  today: "2026-09-28",
  canaries: ["999999"],
  labels: { money: ["balance", "amount"] },
  environment: "test",
};

/** Parses a spec and runs the checks. */
function check(edit: (d: Record<string, unknown>) => void = () => undefined, facts = FACTS) {
  const d = example();
  edit(d);
  return checkSpec(RunSpec.parse(d), facts);
}

/** The first input, for edits. */
function input(d: Record<string, unknown>, i: number): Record<string, unknown> {
  return (d.inputs as Record<string, unknown>[])[i] ?? {};
}

describe("run spec schema", () => {
  test("section 6 §6.3's example parses and passes every check", () => {
    expect(check()).toEqual({ problems: [], warnings: [] });
  });

  test("section 6 §6.4's sign_in spec passes", () => {
    const r = check((d) => {
      Object.assign(d, {
        capability: "sign_in",
        goal: "Sign in as the operator and reach the home page.",
        inputs: [],
        outputs: [],
        expected_effect: "read_only",
        session: null,
        entry: "/",
      });
      delete d.correlation;
    });
    expect(r).toEqual({ problems: [], warnings: [] });
  });

  test.each([
    "goal",
    "inputs",
    "outputs",
    "expected_effect",
    "session",
    "entry",
    "model",
    "prompt",
  ])("a missing %s fails the schema", (field) => {
    const d = Object.fromEntries(Object.entries(example()).filter(([k]) => k !== field));
    expect(RunSpec.safeParse(d).success).toBe(false);
  });

  test("an unknown field and a bad sensitivity fail the schema", () => {
    expect(RunSpec.safeParse({ ...example(), extra: 1 }).success).toBe(false);
    const d = example();
    input(d, 0).sensitivity = "secret";
    expect(RunSpec.safeParse(d).success).toBe(false);
  });
});

describe("example values (section 6 §7.2)", () => {
  test("two inputs with one value are rejected, after normalizing", () => {
    const r = check((d) => {
      input(d, 1).example = "100142.00";
    });
    expect(r.problems).toContain("input deposit: the example is the same value as input member_id");
  });

  test("a date example that is today is rejected", () => {
    const r = check((d) => {
      (d.inputs as unknown[]).push({
        name: "open_date",
        type: "date",
        description: "Open date",
        sensitivity: "none",
        example: "2026-09-28",
      });
    });
    expect(r.problems).toContain(
      "input open_date: the example is today; the screen shows today everywhere",
    );
  });

  test("examples that break their type or constraints are rejected", () => {
    const r = check((d) => {
      input(d, 0).example = "10014A";
      input(d, 1).example = "137";
    });
    expect(r.problems).toEqual([
      "input member_id: the example is not digits only",
      "input deposit: the example is not a money value like 137.00",
    ]);
    const bad = check((d) => {
      Object.assign(input(d, 0), { type: "date", example: "2026-02-30", constraints: undefined });
    });
    expect(bad.problems).toContain("input member_id: the example is not a date like 2026-01-15");
  });

  test("a canary member number is rejected", () => {
    const r = check((d) => {
      input(d, 0).example = "999999";
    });
    expect(r.problems).toContain(
      "input member_id: the example holds a canary member number. Pick another value",
    );
  });

  test("short sensitive values and round amounts warn but pass", () => {
    const r = check((d) => {
      Object.assign(input(d, 0), { example: "142", constraints: undefined });
      input(d, 1).example = "130.00";
    });
    expect(r.problems).toEqual([]);
    expect(r.warnings).toEqual([
      "input member_id: the example is under 4 characters, so text clues cannot use it",
      "input deposit: round amounts appear on screens by chance. Use a value like 137.00",
    ]);
  });

  test("a label the policy words find too low warns", () => {
    const r = check((d) => {
      Object.assign(input(d, 0), { name: "balance_limit", sensitivity: "pii" });
      d.goal = "Open it for {input.balance_limit} with {input.deposit}.";
    });
    expect(r.warnings).toContain(
      "input balance_limit: labelled pii; the label words suggest financial",
    );
  });

  test("example values are refused for a production app and an app not in settings", () => {
    expect(check(undefined, { ...FACTS, environment: "production" }).problems).toContain(
      "inputs: example values in a spec file are accepted only for test apps",
    );
    expect(check(undefined, { ...FACTS, environment: null }).problems).toContain(
      "app: kvfcu is not in the tenant's approved settings",
    );
  });
});

describe("goal, correlation, and negative runs", () => {
  test("the goal names inputs only by reference, and only declared ones", () => {
    const r = check((d) => {
      d.goal = "Open an account for 100142 and {input.nickname}.";
    });
    expect(r.problems).toEqual([
      "goal: {input.nickname} is not an input",
      "goal: it holds input member_id's value. Write {input.member_id}",
    ]);
  });

  test("commits needs correlation; read_only refuses it", () => {
    expect(check((d) => delete d.correlation).problems).toContain(
      "correlation: a commits run needs notes or none (section 6 §16)",
    );
    expect(check((d) => (d.expected_effect = "read_only")).problems).toContain(
      "correlation: only a commits run takes correlation",
    );
  });

  test("a negative run needs an expected outcome and no outputs", () => {
    const r = check((d) => (d.kind = "negative_discovery"));
    expect(r.problems).toEqual([
      "expected_outcome: a negative run needs a code and a description",
      "outputs: a negative run has no outputs",
    ]);
    const ok = check((d) => {
      d.kind = "negative_discovery";
      d.outputs = [];
      d.expected_outcome = { code: "member_not_found", description: "No member has this number" };
    });
    expect(ok.problems).toEqual([]);
  });
});
