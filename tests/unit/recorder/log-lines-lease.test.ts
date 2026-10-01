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
  test("accepts a lease line", () => {
    const p = parseLine(line());
    expect(p.kind).toBe("lease");
    if (p.kind !== "lease") throw new Error("expected lease");
    expect(p.data).toMatchObject({ from: "nobody", to: "bot", reason: "run_start" });
  });

  test.each([
    "run_start",
    "awaiting_decision",
    "decided",
    "takeover_requested",
    "claimed",
    "handed_back",
    "reverified",
    "reverify_failed",
    "run_end",
  ])("accepts reason %s", (reason) => {
    expect(parseLine(line({ reason })).kind).toBe("lease");
  });

  test("accepts an implicit human claim", () => {
    expect(parseLine(line({ from: "nobody", to: "human", reason: "claimed", staff_id: "op_1", implicit: true })).kind).toBe(
      "lease",
    );
  });

  test.each([
    ["an unknown holder", { to: "robot" }],
    ["an unknown reason", { reason: "no_such_reason" }],
    ["a missing implicit flag", { implicit: undefined }],
    ["a non-boolean implicit", { implicit: "yes" }],
    ["a numeric staff ID", { staff_id: 7 }],
    ["an extra field", { extra: 1 }],
  ])("rejects %s", (_name, over) => {
    expect(() => parseLine(line(over))).toThrow();
  });
});
