// Proves the candidate decision line schema accepts a well-formed line and rejects an
// unknown `what` value or a missing field. Design section 9 §6.2, §8.2; section 2 §17.4.
import { describe, expect, test } from "vitest";
import { CandidateDecision } from "../../../src/core/model/candidate-decision.js";

/** A well-formed decision line, without its optional `note`. */
function baseLine(): Record<string, unknown> {
  return {
    schema: "intyy.candidate_decision/1.0",
    what: "risk_second_look",
    subject: "click_remind_later",
    value: "idempotent",
    by: "op_022",
    at: "2026-09-29T09:15:00Z",
  };
}

/** A well-formed decision line, with its optional `note`. */
function line(): Record<string, unknown> {
  return { ...baseLine(), note: "Remind Later only snoozes a banner." };
}

describe("CandidateDecision", () => {
  test("accepts a well-formed line, with or without a note", () => {
    expect(CandidateDecision.safeParse(line()).success).toBe(true);
    expect(CandidateDecision.safeParse(baseLine()).success).toBe(true);
  });

  test("accepts every reconciled `what` value", () => {
    const values = [
      "tag",
      "risk",
      "sensitivity",
      "outcome_name",
      "refusal",
      "waiver",
      "recovery",
      "edit",
      "risk_second_look",
    ];
    for (const what of values) {
      expect(CandidateDecision.safeParse({ ...line(), what }).success).toBe(true);
    }
  });

  test("rejects a `what` not on the reconciled list, such as the patch-only value", () => {
    expect(CandidateDecision.safeParse({ ...line(), what: "patch" }).success).toBe(false);
    expect(CandidateDecision.safeParse({ ...line(), what: "bogus" }).success).toBe(false);
  });

  test("rejects a missing field and an unknown field", () => {
    expect(CandidateDecision.safeParse({ ...line(), by: undefined }).success).toBe(false);
    expect(CandidateDecision.safeParse({ ...line(), extra: 1 }).success).toBe(false);
  });
});
