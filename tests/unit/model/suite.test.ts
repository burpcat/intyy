// Proves the certify suite schema (`intyy.suite/1.0`) and its loader check `checkSuite`.
// Design section 8 §6.1 and section 9 §8.7. M06 task 7.
import { describe, expect, test } from "vitest";
import { checkSuite, Suite } from "../../../src/core/model/suite.js";

/** A minimal, clean suite: one class, the matrix and stability both name it, no extras. */
function baseSuite(): Record<string, unknown> {
  return {
    schema: "intyy.suite/1.0",
    capability: "kvfcu/open_share_subaccount@1",
    revision: 1,
    reason: "Test suite.",
    classes: [
      {
        id: "valid",
        inputs: { member_id: "@members.valid", notes: "grandchild savings" },
        expect: { status: "success" },
      },
    ],
    matrix: { class: "valid", profiles: "standard" },
    stability: { class: "valid", levels: [0.05, 0.15, 0.3], seeds: 5, twins: true },
    drills: { count: 1 },
    extra: [],
    setup: [],
    provenance: { runs: [], decisions: [], sealed: null },
  };
}

describe("Suite schema", () => {
  test("the Suite schema accepts a clean suite and rejects bad shapes", () => {
    // accepts a clean suite
    expect(Suite.safeParse(baseSuite()).success).toBe(true);
    // rejects the wrong schema literal
    {
      const doc = { ...baseSuite(), schema: "intyy.suite/2.0" };
      expect(Suite.safeParse(doc).success).toBe(false);
    }
    // rejects a capability missing its major version
    {
      const doc = { ...baseSuite(), capability: "kvfcu/open_share_subaccount" };
      expect(Suite.safeParse(doc).success).toBe(false);
    }
    // rejects a capability with an upper-case app
    {
      const doc = { ...baseSuite(), capability: "KVFCU/open_share_subaccount@1" };
      expect(Suite.safeParse(doc).success).toBe(false);
    }
  });
});

describe("checkSuite", () => {
  test("checkSuite reports duplicate IDs and unknown class names", () => {
    // a clean suite has no problems
    expect(checkSuite(Suite.parse(baseSuite()))).toEqual([]);
    // a duplicate class ID is reported
    {
      const doc = baseSuite();
      const classes = doc.classes as Record<string, unknown>[];
      doc.classes = [...classes, { ...classes[0] }];
      expect(checkSuite(Suite.parse(doc))).toContain("duplicate_class: valid");
    }
    // a duplicate extra case ID is reported
    {
      const doc = baseSuite();
      doc.extra = [
        { id: "e1", class: "valid", faults: [{ kind: "server_error", at: "@commit_point" }], expect: { status: "success" } },
        { id: "e1", class: "valid", faults: [{ kind: "server_error", at: "@commit_point" }], expect: { status: "success" } },
      ];
      expect(checkSuite(Suite.parse(doc))).toContain("duplicate_extra: e1");
    }
    // an extra case naming an unknown class is reported
    {
      const doc = baseSuite();
      doc.extra = [
        { id: "e1", class: "no_such_class", faults: [{ kind: "server_error", at: "@commit_point" }], expect: { status: "success" } },
      ];
      expect(checkSuite(Suite.parse(doc))).toContain("unknown_class: extra e1 names class no_such_class");
    }
    // the matrix naming an unknown class is reported
    {
      const doc = baseSuite();
      doc.matrix = { class: "no_such_class", profiles: "standard" };
      expect(checkSuite(Suite.parse(doc))).toContain("unknown_class: matrix names class no_such_class");
    }
    // stability naming an unknown class is reported
    {
      const doc = baseSuite();
      doc.stability = { class: "no_such_class", levels: [0.1], seeds: 1, twins: false };
      expect(checkSuite(Suite.parse(doc))).toContain("unknown_class: stability names class no_such_class");
    }
  });
});
