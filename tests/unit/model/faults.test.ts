// Proves the fault profile schema (`intyy.faults/1.0`), its `FaultProfile` refine (`expect_window`
// rules around `@commit_point`, CONTRACT §6.2, §6.3), and `checkFaults`. Design section 8 §6.3
// and section 9 §8.7. M06 task 7.
import { describe, expect, test } from "vitest";
import { checkFaults, FaultProfile, Faults } from "../../../src/core/model/faults.js";

/** A minimal, clean fault profile set: one window profile, one commit-point profile. */
function baseFaults(): Record<string, unknown> {
  return {
    schema: "intyy.faults/1.0",
    app: "kvfcu",
    revision: 1,
    profiles: [
      {
        id: "server_error",
        kind: "server_error",
        at: "@each_request_step",
        expect_commit: "reconciles_absent",
        expect_window: "recovers",
      },
      {
        id: "reply_lost",
        kind: "drop_after_confirm",
        at: "@commit_point",
        expect_commit: "reconciles_found",
      },
    ],
  };
}

describe("Faults schema", () => {
  test("the Faults schema accepts clean sets and well-formed anchors, and rejects bad literals, kinds, and anchors", () => {
    // accepts a clean fault profile set
    expect(Faults.safeParse(baseFaults()).success).toBe(true);
    // rejects the wrong schema literal
    {
      const doc = { ...baseFaults(), schema: "intyy.faults/2.0" };
      expect(Faults.safeParse(doc).success).toBe(false);
    }
    // rejects an unknown fault kind
    {
      const doc = baseFaults();
      (doc.profiles as Record<string, unknown>[])[0] = {
        id: "bogus",
        kind: "teleport",
        at: "@each_request_step",
        expect_commit: "reconciles_absent",
        expect_window: "recovers",
      };
      expect(Faults.safeParse(doc).success).toBe(false);
    }
    // rejects a malformed @step anchor
    {
      const doc = baseFaults();
      (doc.profiles as Record<string, unknown>[])[0] = {
        id: "bad_anchor",
        kind: "server_error",
        at: "@step:Not_Snake",
        expect_commit: "reconciles_absent",
        expect_window: "recovers",
      };
      expect(Faults.safeParse(doc).success).toBe(false);
    }
    // accepts a well-formed @step anchor
    {
      const doc = baseFaults();
      (doc.profiles as Record<string, unknown>[])[0] = {
        id: "step_anchor",
        kind: "server_error",
        at: "@step:click_submit",
        expect_commit: "reconciles_absent",
        expect_window: "recovers",
      };
      expect(Faults.safeParse(doc).success).toBe(true);
    }
  });
});

describe("FaultProfile refine: expect_window around @commit_point (CONTRACT §6.2, §6.3)", () => {
  test("FaultProfile refuses or accepts expect_window by anchor", () => {
    // @commit_point with expect_window set is refused
    {
      const p = {
        id: "reply_lost",
        kind: "drop_after_confirm",
        at: "@commit_point",
        expect_commit: "reconciles_found",
        expect_window: "recovers",
      };
      expect(FaultProfile.safeParse(p).success).toBe(false);
    }
    // @commit_point with expect_window left out is accepted
    {
      const p = {
        id: "reply_lost",
        kind: "drop_after_confirm",
        at: "@commit_point",
        expect_commit: "reconciles_found",
      };
      expect(FaultProfile.safeParse(p).success).toBe(true);
    }
    // @each_request_step with expect_window left out is refused
    {
      const p = {
        id: "server_error",
        kind: "server_error",
        at: "@each_request_step",
        expect_commit: "reconciles_absent",
      };
      expect(FaultProfile.safeParse(p).success).toBe(false);
    }
    // @step:<id> with expect_window left out is refused
    {
      const p = {
        id: "server_error",
        kind: "server_error",
        at: "@step:sign_in",
        expect_commit: "reconciles_absent",
      };
      expect(FaultProfile.safeParse(p).success).toBe(false);
    }
    // @step:<id> with expect_window set is accepted
    {
      const p = {
        id: "server_error",
        kind: "server_error",
        at: "@step:sign_in",
        expect_commit: "reconciles_absent",
        expect_window: "fails:app_error",
      };
      expect(FaultProfile.safeParse(p).success).toBe(true);
    }
  });
});

describe("checkFaults", () => {
  test("checkFaults reports a duplicate profile ID and passes a clean set", () => {
    // a clean set has no problems
    expect(checkFaults(Faults.parse(baseFaults()))).toEqual([]);
    // a duplicate profile ID is reported
    {
      const doc = baseFaults();
      const profiles = doc.profiles as Record<string, unknown>[];
      doc.profiles = [...profiles, { ...profiles[0] }];
      expect(checkFaults(Faults.parse(doc))).toContain("duplicate_profile: server_error");
    }
  });
});
