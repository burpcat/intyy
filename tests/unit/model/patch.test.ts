// Proves the patch schema accepts the design's section 2 §18.7 example, that each field allow
// list and ID format rejects the right shape, and that the base-dependent checks of §18.3 and
// §19.2 run only when a base artifact is given.
import { describe, expect, test } from "vitest";
import { Artifact } from "../../../src/core/model/artifact.js";
import { checkPatch } from "../../../src/core/model/patch-checks.js";
import { Patch } from "../../../src/core/model/patch.js";
import { artifactExample } from "../../fixtures/design-examples.js";

/** Section 2 §18.7, full example. */
function patchExample(): Record<string, unknown> {
  return {
    schema: "intyy.patch/1.0",
    tenant: "lakeshore",
    base: "kvfcu/open_share_subaccount@1",
    revision: 1,
    reason: "Lakeshore labels the Search button 'Find' and moves it left.",
    targets: {
      search_button: { clues: { name: "Find", text: "Find", region: null } },
    },
    conditions: {
      no_member_text: { text: "Member does not exist" },
    },
    provenance: {
      runs: [{ run_id: "run_2026-10-02_c9d1wq5e2k", kind: "replay" }],
      decisions: [
        { what: "patch", subject: "search_button", value: "rename", by: "op_022", at: "2026-10-02T09:15:00Z" },
      ],
      sealed: { by: "op_022", at: "2026-10-02T09:20:00Z" },
    },
  };
}

/** A deep clone, so each test mutates its own copy. */
function clone(): Record<string, unknown> {
  return structuredClone(patchExample());
}

/** The design's full artifact example, parsed, as the base for the base-dependent checks. */
function base(): Artifact {
  const result = Artifact.safeParse(artifactExample());
  if (!result.success) throw new Error("artifactExample no longer parses");
  return result.data;
}

describe("intyy.patch/1.0", () => {
  test("the section 2 §18.7 full example parses", () => {
    expect(Patch.safeParse(clone()).success).toBe(true);
  });

  describe("§18.3 field allow lists", () => {
    test("rejects `id` on a target change", () => {
      const doc = clone();
      const targets = doc.targets as Record<string, Record<string, unknown>>;
      targets.search_button = { ...targets.search_button, id: "search_button" };
      expect(Patch.safeParse(doc).success).toBe(false);
    });

    test("accepts `within` on a target change", () => {
      const doc = clone();
      const targets = doc.targets as Record<string, Record<string, unknown>>;
      targets.search_button = { ...targets.search_button, within: "search_panel" };
      expect(Patch.safeParse(doc).success).toBe(true);
    });

    test("rejects `check` on a condition change", () => {
      const doc = clone();
      const conditions = doc.conditions as Record<string, Record<string, unknown>>;
      conditions.no_member_text = { ...conditions.no_member_text, check: "text_visible" };
      expect(Patch.safeParse(doc).success).toBe(false);
    });

    test("accepts `match` on a condition change", () => {
      const doc = clone();
      const conditions = doc.conditions as Record<string, Record<string, unknown>>;
      conditions.no_member_text = { ...conditions.no_member_text, match: "contains" };
      expect(Patch.safeParse(doc).success).toBe(true);
    });

    test("rejects a field no leaf condition ever takes, like `format`", () => {
      const doc = clone();
      const conditions = doc.conditions as Record<string, Record<string, unknown>>;
      conditions.no_member_text = { ...conditions.no_member_text, format: "YYYY-MM-DD" };
      expect(Patch.safeParse(doc).success).toBe(false);
    });
  });

  describe("ID formats", () => {
    test("rejects a target key that is not lower snake case", () => {
      const doc = clone();
      doc.targets = { SearchButton: { clues: { name: "Find" } } };
      expect(Patch.safeParse(doc).success).toBe(false);
    });

    test("rejects a base with no major version", () => {
      const doc = clone();
      doc.base = "kvfcu/open_share_subaccount";
      expect(Patch.safeParse(doc).success).toBe(false);
    });

    test("accepts a well-formed base link and tenant", () => {
      const doc = clone();
      expect(Patch.safeParse(doc).success).toBe(true);
    });
  });

  describe("checkPatch: base-dependent checks (section 2 §18.3, §19.2)", () => {
    function parse(doc: Record<string, unknown>): Patch {
      const result = Patch.safeParse(doc);
      if (!result.success) throw new Error(`fixture mutation broke the schema: ${result.error.message}`);
      return result.data;
    }

    test("with no base, every ID passes unchecked", () => {
      const doc = clone();
      doc.targets = { no_such_target: { clues: { name: "x" } } };
      expect(checkPatch(parse(doc))).toEqual([]);
    });

    test("accepts a patch whose targets and conditions exist in the base", () => {
      expect(checkPatch(parse(clone()), base())).toEqual([]);
    });

    test("rejects a target the base does not have", () => {
      const doc = clone();
      doc.targets = { no_such_target: { clues: { name: "x" } } };
      const problems = checkPatch(parse(doc), base());
      expect(problems.map((p) => p.code)).toContain("dangling_ref");
    });

    test("rejects a condition the base does not have", () => {
      const doc = clone();
      doc.conditions = { no_such_condition: { text: "x" } };
      const problems = checkPatch(parse(doc), base());
      expect(problems.map((p) => p.code)).toContain("dangling_ref");
    });

    test("rejects a `within` that names no target in the base", () => {
      const doc = clone();
      const targets = doc.targets as Record<string, Record<string, unknown>>;
      targets.search_button = { ...targets.search_button, within: "no_such_target" };
      const problems = checkPatch(parse(doc), base());
      expect(problems.map((p) => p.code)).toContain("dangling_ref");
    });

    test("rejects a change to a combined condition (all_of, any_of, or not)", () => {
      const doc = clone();
      // `form_ready` is an `all_of` combiner in the design's full example (section 2 §21).
      doc.conditions = { form_ready: { match: "exact" } };
      const problems = checkPatch(parse(doc), base());
      expect(problems.map((p) => p.code)).toContain("combined_condition_patch");
    });
  });
});
