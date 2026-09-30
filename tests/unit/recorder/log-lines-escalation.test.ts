// Proves `parseLine` accepts every mailbox request kind on an `escalation` line, including the
// replay kinds (start_confirmation, reconciliation_decision, retry_decision), and still rejects
// an unknown kind. Design section 3 §5.7; docs/decisions.md, M06.
import { describe, expect, test } from "vitest";
import { parseLine } from "../../../src/core/recorder/log-lines.js";

/** One escalation line of `kind`. */
function line(kind: string): unknown {
  return {
    seq: 1,
    at: "2026-01-15T09:00:00.000Z",
    run_id: "run_2026-01-15_1000000001",
    step: "click_confirm",
    by: "engine",
    event: "escalation",
    data: { kind, reason: "reconciliation_waived", state: "open" },
  };
}

describe("parseLine: escalation kinds", () => {
  test.each(["start_confirmation", "reconciliation_decision", "retry_decision", "approval", "takeover"])(
    "accepts %s",
    (kind) => {
      expect(parseLine(line(kind)).kind).toBe("escalation");
    },
  );

  test("rejects an unknown kind", () => {
    expect(() => parseLine(line("no_such_kind"))).toThrow();
  });
});
