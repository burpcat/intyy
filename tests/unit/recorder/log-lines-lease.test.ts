// Proves `parseLine` accepts a `lease` line and rejects a malformed one.
// Design section 3 §6.4 (the `lease` event and its reasons); section 7 §12.2. M07 task 1.
import { describe, expect, test } from "vitest";
import { parseLine } from "../../../src/core/recorder/log-lines.js";

/** One lease line, with `data` fields replaced by `over`. */
function line(over: Record<string, unknown> = {}): unknown {
  return {
    seq: 2,
    at: "2026-01-15T09:00:00.000Z",
    run_id: "run_2026-01-15_1000000001",
    step: null,
    by: "engine",
    event: "lease",
    data: { from: "nobody", to: "bot", reason: "run_start", staff_id: null, implicit: false, ...over },
  };
}

describe("parseLine: lease", () => {
  test("accepts a lease line, every reason, and an implicit human claim", () => {
    const p = parseLine(line());
    expect(p.kind).toBe("lease");
    if (p.kind !== "lease") throw new Error("expected lease");
    expect(p.data).toMatchObject({ from: "nobody", to: "bot", reason: "run_start" });
    for (const reason of [
      "run_start",
      "awaiting_decision",
      "decided",
      "takeover_requested",
      "claimed",
      "handed_back",
      "reverified",
      "reverify_failed",
      "run_end",
    ]) {
      expect(parseLine(line({ reason })).kind, reason).toBe("lease");
    }
    expect(
      parseLine(line({ from: "nobody", to: "human", reason: "claimed", staff_id: "op_1", implicit: true })).kind,
      "implicit human claim",
    ).toBe("lease");
  });

  test("rejects a malformed lease line", () => {
    for (const [name, over] of [
      ["an unknown holder", { to: "robot" }],
      ["an unknown reason", { reason: "no_such_reason" }],
      ["a missing implicit flag", { implicit: undefined }],
      ["a non-boolean implicit", { implicit: "yes" }],
      ["a numeric staff ID", { staff_id: 7 }],
      ["an extra field", { extra: 1 }],
    ] as const) {
      expect(() => parseLine(line(over)), name).toThrow();
    }
  });
});
