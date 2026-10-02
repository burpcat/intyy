// Proves risk.ts (section 6 §14.9): the commit point, and the recovery placeholder.
import { describe, expect, test } from "vitest";
import type { Step } from "../../../src/core/model/artifact/steps.js";
import type { RecorderIssue } from "../../../src/core/recorder/issues.js";
import { buildRecovery, pickCommitPoint } from "../../../src/core/recorder/risk.js";

function step(id: string, risk: "idempotent" | "irreversible"): Step {
  return {
    id,
    intent: "x",
    action: { type: "click", target: "t" },
    precondition: "p",
    checkpoint: "c",
    outcomes: [],
    risk,
    timeout_ms: 5000,
  };
}

describe("pickCommitPoint", () => {
  test("pickCommitPoint finds none for read-only, one for a single irreversible step, and blocks otherwise", () => {
    {
      // read-only capabilities never have a commit point
      expect(pickCommitPoint([step("a", "irreversible")], "read_only", [])).toBeNull();
    }
    {
      // exactly one irreversible step is the commit point
      const issues: RecorderIssue[] = [];
      expect(
        pickCommitPoint([step("a", "idempotent"), step("b", "irreversible")], "commits", issues),
      ).toBe("b");
      expect(issues).toEqual([]);
    }
    {
      // zero or two irreversible steps is a blocking issue
      const none: RecorderIssue[] = [];
      expect(pickCommitPoint([step("a", "idempotent")], "commits", none)).toBeNull();
      expect(none).toHaveLength(1);
      const two: RecorderIssue[] = [];
      expect(
        pickCommitPoint([step("a", "irreversible"), step("b", "irreversible")], "commits", two),
      ).toBeNull();
      expect(two).toHaveLength(1);
    }
  });
});

describe("buildRecovery", () => {
  test("undefined for read-only; a placeholder for commits", () => {
    expect(buildRecovery(null, "read_only")).toBeUndefined();
    expect(buildRecovery("click_confirm", "commits")).toEqual({
      commit_point: "click_confirm",
      reconciliation: null,
    });
  });
});
