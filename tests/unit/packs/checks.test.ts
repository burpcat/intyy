// Proves the pack loader checks (design section 5 §5.6): every check accepts a clean pack and
// rejects the one thing it exists to catch. Schema-only rules (SnakeId case, the risk enum
// excluding `irreversible`, `navigate`'s location shape, no `read` actions, each class's own
// fields, the two allowed `hard_failure` codes) are proven through `Pack.safeParse` itself,
// since `checkPack` never re-checks what the schema already forbids. M06 task 1.
import { describe, expect, test } from "vitest";
import { Pack } from "../../../src/core/model/pack.js";
import { checkPack, type PackCheckContext } from "../../../src/core/packs/checks.js";

/** A minimal, clean pack: one recoverable handler, its own target and condition, with the
 * risk decision `checkHandler` needs. Every test starts here and mutates one thing. */
function basePack(): Record<string, unknown> {
  return {
    schema: "intyy.pack/1.0",
    scope: { level: "global" },
    revision: 1,
    reason: "Test pack.",
    targets: [{ id: "ok_button", description: "OK button on the popup", clues: { role: "button", name: "OK" } }],
    conditions: [
      { id: "popup_shown", check: "element_visible", description: "The popup is showing", target: "ok_button" },
    ],
    handlers: [
      {
        id: "popup_handler",
        description: "A dismissible popup.",
        class: "recoverable",
        detector: "popup_shown",
        response: [{ type: "click", target: "ok_button", risk: "idempotent" }],
        limits: { per_step: 1, per_run: 1 },
        on_exhausted: { class: "hard_failure", failure: "app_error" },
        fixtures: { fire: ["popup_fire_01"], no_fire: ["popup_near_miss_01"] },
      },
    ],
    disable: [],
    provenance: {
      runs: [],
      decisions: [{ what: "risk", subject: "popup_handler.response[0]", value: "idempotent", by: "op_017", at: "2026-09-30T00:00:00Z" }],
      sealed: null,
    },
  };
}

/** Parses through the real schema first (only bugs skip this in production code), then runs
 * `checkPack`. A schema failure surfaces as a thrown error, so a test that expects one uses
 * `Pack.safeParse` directly instead. */
function check(edit: (p: Record<string, unknown>) => void, ctx: PackCheckContext = {}): string[] {
  const p = basePack();
  edit(p);
  const parsed = Pack.parse(p);
  return checkPack(parsed, ctx).map((x) => x.code);
}

/** The first handler (or target) in a still-raw pack body, never `!`. */
function firstHandler(p: Record<string, unknown>): Record<string, unknown> {
  const h = (p.handlers as Record<string, unknown>[])[0];
  if (h === undefined) throw new Error("basePack has no handler");
  return h;
}

function firstTarget(p: Record<string, unknown>): Record<string, unknown> {
  const t = (p.targets as Record<string, unknown>[])[0];
  if (t === undefined) throw new Error("basePack has no target");
  return t;
}

function firstCondition(p: Record<string, unknown>): Record<string, unknown> {
  const c = (p.conditions as Record<string, unknown>[])[0];
  if (c === undefined) throw new Error("basePack has no condition");
  return c;
}

/** Overwrites `provenance.decisions` with one `risk` stamp for `popup_handler.response[0]`,
 * the shape every test that changes the response action still needs. */
function withRiskStamp(p: Record<string, unknown>): void {
  (p.provenance as { decisions: Record<string, unknown>[] }).decisions = [
    { what: "risk", subject: "popup_handler.response[0]", value: "idempotent", by: "op_017", at: "2026-09-30T00:00:00Z" },
  ];
}

describe("a clean pack passes every check", () => {
  test("with no ancestor or policy context", () => {
    expect(check(() => undefined)).toEqual([]);
  });
});

describe("format", () => {
  test("a duplicate handler ID is rejected", () => {
    const codes = check((p) => {
      const handlers = p.handlers as Record<string, unknown>[];
      handlers.push({ ...handlers[0] });
    });
    expect(codes).toContain("duplicate_id");
  });

  test("a bad-case ID fails the schema itself, before checkPack ever runs", () => {
    const p = basePack();
    firstTarget(p).id = "OkButton";
    expect(Pack.safeParse(p).success).toBe(false);
  });

  test("disable outside app_version/tenant scope is rejected", () => {
    const codes = check((p) => {
      p.disable = ["some_handler"];
    });
    expect(codes).toContain("disable_not_versioned");
  });

  test("disable at tenant scope is fine", () => {
    const codes = check((p) => {
      p.scope = { level: "tenant", tenant: "keystone", app: "kvfcu" };
      p.disable = ["some_handler"];
    });
    expect(codes).not.toContain("disable_not_versioned");
  });

  test("app_versions on a handler outside tenant scope is rejected", () => {
    const codes = check((p) => {
      firstHandler(p).app_versions = ["9.*"];
    });
    expect(codes).toContain("app_versions_not_tenant");
  });

  test("app_versions on a handler at tenant scope is fine", () => {
    const codes = check((p) => {
      p.scope = { level: "tenant", tenant: "keystone", app: "kvfcu" };
      firstHandler(p).app_versions = ["9.*"];
    });
    expect(codes).not.toContain("app_versions_not_tenant");
  });
});

describe("references", () => {
  test("a handler's detector naming an unknown condition is a dangling ref", () => {
    const codes = check((p) => {
      firstHandler(p).detector = "no_such_condition";
    });
    expect(codes).toContain("dangling_ref");
  });

  test("a condition's target naming an unknown target is a dangling ref", () => {
    const codes = check((p) => {
      firstCondition(p).target = "no_such_target";
    });
    expect(codes).toContain("dangling_ref");
  });

  test("a ref cycle between two conditions is rejected", () => {
    const codes = check((p) => {
      p.conditions = [
        { id: "a", description: "a", check: "ref", ref: "b" },
        { id: "b", description: "b", check: "ref", ref: "a" },
      ];
      firstHandler(p).detector = "a";
    });
    expect(codes).toContain("ref_cycle");
  });

  test("{input.*} in a target's clue text is rejected: packs cannot know a capability's inputs", () => {
    const codes = check((p) => {
      firstTarget(p).clues = { role: "button", name: "OK", text: "{input.member_id}" };
    });
    expect(codes).toContain("bad_namespace");
  });

  test("{system.last_good_path} inside condition text is rejected: it belongs only in navigate", () => {
    const codes = check((p) => {
      (p.conditions as Record<string, unknown>[])[0] = {
        id: "popup_shown",
        check: "text_visible",
        description: "The popup is showing",
        text: "{system.last_good_path}",
        match: "contains",
      };
    });
    expect(codes).toContain("bad_namespace");
  });

  test("{system.last_good_path} as a navigate response location is fine", () => {
    const codes = check((p) => {
      const h = firstHandler(p);
      h.response = [{ type: "navigate", location: "{system.last_good_path}", risk: "idempotent" }];
      withRiskStamp(p);
    });
    expect(codes).toEqual([]);
  });

  test("a {secret.*} reference that is not the whole type value is rejected", () => {
    const codes = check((p) => {
      const h = firstHandler(p);
      h.response = [{ type: "type", target: "ok_button", value: "prefix {secret.operator_password} suffix", risk: "idempotent" }];
      withRiskStamp(p);
    });
    expect(codes).toContain("secret_not_whole_value");
  });

  test("a whole {secret.*} type value is fine when the policy declares it", () => {
    const codes = check(
      (p) => {
        const h = firstHandler(p);
        h.response = [{ type: "type", target: "ok_button", value: "{secret.operator_password}", risk: "idempotent" }];
        withRiskStamp(p);
      },
      { secretDeclared: (name) => name === "operator_password" },
    );
    expect(codes).toEqual([]);
  });

  test("an {output.*} or {result.*} reference in a type value is rejected outright", () => {
    const codes = check((p) => {
      const h = firstHandler(p);
      h.response = [{ type: "type", target: "ok_button", value: "{result.account_number}", risk: "idempotent" }];
      withRiskStamp(p);
    });
    expect(codes).toContain("bad_namespace");
  });
});

describe("detectors", () => {
  test("a field_value check inside a pack condition is rejected", () => {
    const codes = check((p) => {
      p.conditions = [
        { id: "popup_shown", check: "field_value", description: "x", target: "ok_button", value: "*", match: "wildcard" },
      ];
    });
    expect(codes).toContain("no_field_value_in_pack");
  });

  test("mask text inside a detector's text_visible check is rejected", () => {
    const codes = check((p) => {
      p.conditions = [
        { id: "popup_shown", check: "text_visible", description: "x", text: "Hello [name#1]", match: "contains" },
      ];
    });
    expect(codes).toContain("mask_text_in_detector");
  });
});

describe("actions (schema level)", () => {
  test("a read action is not a legal pack response action", () => {
    const p = basePack();
    firstHandler(p).response = [{ type: "read", output: "x", risk: "idempotent" }];
    expect(Pack.safeParse(p).success).toBe(false);
  });

  test("an irreversible risk on a response action is rejected by the schema", () => {
    const p = basePack();
    firstHandler(p).response = [{ type: "click", target: "ok_button", risk: "irreversible" }];
    expect(Pack.safeParse(p).success).toBe(false);
  });

  test("a navigate location with no leading slash, and not {system.last_good_path}, fails the schema", () => {
    const p = basePack();
    firstHandler(p).response = [{ type: "navigate", location: "home", risk: "idempotent" }];
    expect(Pack.safeParse(p).success).toBe(false);
  });

  test("every response action needs a risk decision in provenance", () => {
    const codes = check((p) => {
      (p.provenance as { decisions: unknown[] }).decisions = [];
    });
    expect(codes).toContain("missing_risk_decision");
  });

  test("a fixed navigate path outside the app's allowed paths is rejected, given a policy context", () => {
    const codes = check(
      (p) => {
        const h = firstHandler(p);
        h.response = [{ type: "navigate", location: "/denied", risk: "idempotent" }];
        withRiskStamp(p);
      },
      { pathAllowed: (path) => path !== "/denied" },
    );
    expect(codes).toContain("policy_path_denied");
  });
});

describe("classes (schema level)", () => {
  test("a business_outcome handler with a recoverable-only field fails the schema", () => {
    const p = basePack();
    (p.handlers as Record<string, unknown>[])[0] = {
      id: "member_not_found",
      description: "No such member.",
      class: "business_outcome",
      detector: "popup_shown",
      outcome: { code: "member_not_found", description: "No such member." },
      response: [{ type: "click", target: "ok_button", risk: "idempotent" }],
      fixtures: { fire: ["a"], no_fire: ["b"] },
    };
    expect(Pack.safeParse(p).success).toBe(false);
  });

  test("a hard_failure naming an unlisted code fails the schema", () => {
    const p = basePack();
    (p.handlers as Record<string, unknown>[])[0] = {
      id: "maintenance",
      description: "Maintenance page.",
      class: "hard_failure",
      detector: "popup_shown",
      failure: "not_a_real_code",
      fixtures: { fire: ["a"], no_fire: ["b"] },
    };
    expect(Pack.safeParse(p).success).toBe(false);
  });
});

describe("overrides", () => {
  test("a new ID must not set overrides: true", () => {
    const codes = check((p) => {
      firstHandler(p).overrides = true;
    }, { ancestorHandlerIds: new Set() });
    expect(codes).toContain("overrides_new_id");
  });

  test("an ID that reuses a parent's ID must set overrides: true", () => {
    const codes = check(() => undefined, { ancestorHandlerIds: new Set(["popup_handler"]) });
    expect(codes).toContain("overrides_missing");
  });

  test("overrides: true on a reused ID is fine", () => {
    const codes = check(
      (p) => {
        firstHandler(p).overrides = true;
      },
      { ancestorHandlerIds: new Set(["popup_handler"]) },
    );
    expect(codes).not.toContain("overrides_missing");
    expect(codes).not.toContain("overrides_new_id");
  });

  test("with no ancestor context, override checks are skipped, not guessed", () => {
    const codes = check((p) => {
      firstHandler(p).overrides = true;
    });
    expect(codes).not.toContain("overrides_new_id");
    expect(codes).not.toContain("overrides_missing");
  });
});
