// Proves the `waived` marker on a batch report case (design section 8 §7.8; docs/decisions.md,
// M06, 2026-09-30): absent or `true` parses, `false` is rejected.
import { describe, expect, test } from "vitest";
import { BatchReport } from "../../../src/core/model/batch-report.js";

/** A minimal valid report; `extra` is merged into its one case. */
function reportWith(extra: Record<string, unknown>): unknown {
  return {
    schema: "intyy.batch_report/1.0",
    batch_id: "batch_2026-01-15_1000000001",
    tenant: "keystone",
    app: "kvfcu",
    capability: "open_sub",
    ended_at: "2026-01-15T09:00:00.000Z",
    cases: [
      {
        case_id: "case",
        run_id: "run_2026-01-15_1000000002",
        class: "valid",
        result: { status: "escalated", detail: "reconciliation_decision/reconciliation_waived/click_confirm" },
        truth: {},
        verdict: "pass",
        ...extra,
      },
    ],
    gate: { passed: true },
  };
}

describe("BatchReport case.waived", () => {
  test("case.waived parses when absent or true and rejects false", () => {
    // absent parses
    expect(BatchReport.safeParse(reportWith({})).success).toBe(true);
    // true parses
    expect(BatchReport.safeParse(reportWith({ waived: true })).success).toBe(true);
    // false is rejected
    expect(BatchReport.safeParse(reportWith({ waived: false })).success).toBe(false);
  });
});
