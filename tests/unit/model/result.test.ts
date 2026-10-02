// Proves the result schema accepts the design's section 3 §5 examples, refuses a status block
// that does not fit its status, and parses every commit state and status.
import { describe, expect, test } from "vitest";
import { CommitState, Result, Status } from "../../../src/core/model/result.js";

/** Fields every result needs, besides `status` and its own block. */
function envelope(): Record<string, unknown> {
  return {
    schema: "intyy.result/1.0",
    run_id: "run_2026-09-24_7kq2m9x4tb",
    request_id: "agt-teller-7f3c-0042",
    capability: { name: "kvfcu/open_share_subaccount", version: "1.0.0", patch_revision: null },
    warnings: [],
    recoveries: [],
    interventions: [],
    timing: {
      started_at: "2026-09-24T10:15:02.004Z",
      ended_at: "2026-09-24T10:15:44.918Z",
      duration_ms: 42914,
      human_ms: 0,
    },
    evidence: "runs/run_2026-09-24_7kq2m9x4tb/",
  };
}

describe("intyy.result/1.0", () => {
  test("the result schema parses each status and effect block and rejects bad ones", () => {
    // section 3 §5.3 success parses, with an effect block
    {
      const result = {
        ...envelope(),
        status: "success",
        outputs: { account_number: "SB00481223" },
        effect: { commit: "confirmed", performed_by: "bot", sent_at: "2026-09-24T10:15:41.220Z", attempts: [] },
      };
      expect(Result.safeParse(result).success).toBe(true);
    }
    // section 3 §5.4 business_outcome parses
    {
      const result = {
        ...envelope(),
        status: "business_outcome",
        outcome: {
          code: "member_not_found",
          description: "No member has this ID",
          step: "click_search",
          decided_by: "code",
          set_by: null,
        },
      };
      expect(Result.safeParse(result).success).toBe(true);
    }
    // section 3 §5.5 failed parses, worst-case effect included
    {
      const result = {
        ...envelope(),
        status: "failed",
        failure: {
          code: "checkpoint_timeout",
          message: "The step's expected result did not appear within 8000 ms.",
          step: "click_search",
          phase: "checkpoint",
          expected: { condition: "one_result_row", description: "The results table has exactly one row" },
          observed: {
            location: "/members/search",
            checks: [{ path: "one_result_row", check: "count", passed: false, observed: "0 rows" }],
          },
          attempts: 3,
          ladder: { rung: 1, verdict: "hard_failure", ref: "retry_limit" },
          transient: true,
          safe_to_retry: true,
          files: ["screens/00047_click_search_failed.png"],
        },
        effect: {
          commit: "uncertain",
          performed_by: "bot",
          sent_at: "2026-09-24T10:31:07.400Z",
          check: { run_id: "run_2026-09-24_n5k9t3b7fe", decided_by: "jev", staff_id: null },
          attempts: [],
        },
      };
      expect(Result.safeParse(result).success).toBe(true);
    }
    // section 3 §5.6 rejected parses, capability unresolved
    {
      const result = {
        ...envelope(),
        capability: { name: "kvfcu/open_share_subaccount", version: null, patch_revision: null },
        status: "rejected",
        rejection: {
          errors: [
            {
              code: "invalid_input",
              field: "deposit",
              reason: "out_of_range",
              message: "deposit must be between 1.00 and 10000.00.",
            },
          ],
        },
      };
      expect(Result.safeParse(result).success).toBe(true);
    }
    // running has no status block
    expect(Result.safeParse({ ...envelope(), status: "running" }).success).toBe(true);
    expect(
      Result.safeParse({ ...envelope(), status: "running", outputs: {} }).success,
    ).toBe(false);
    // section 3 §5.7 escalated parses
    {
      const result = {
        ...envelope(),
        status: "escalated",
        escalation: {
          kind: "approval",
          reason: "no_authorization",
          step: "click_confirm",
          waiting_since: "2026-09-24T10:15:30.112Z",
          deadline: "2026-09-24T10:45:30.112Z",
          handled_by: null,
          poll_after_ms: 5000,
        },
      };
      expect(Result.safeParse(result).success).toBe(true);
    }
    // every status parses
    expect(Status.options).toEqual([
      "success",
      "business_outcome",
      "failed",
      "rejected",
      "running",
      "escalated",
    ]);
    // every commit state parses in an effect block
    for (const commit of CommitState.options) {
      const result = {
        ...envelope(),
        status: "running",
        effect: { commit, performed_by: null, sent_at: null, attempts: [] },
      };
      expect(Result.safeParse(result).success).toBe(true);
    }
    // a status block that does not fit its status is rejected
    {
      const result = { ...envelope(), status: "success", outcome: { code: "x" } };
      expect(Result.safeParse(result).success).toBe(false);
    }
    // an unknown status is rejected
    expect(Result.safeParse({ ...envelope(), status: "queued" }).success).toBe(false);
    // an unknown field is rejected
    expect(Result.safeParse({ ...envelope(), status: "running", extra: 1 }).success).toBe(false);
  });
});
