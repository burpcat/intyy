// Proves the jev threshold schema (`intyy.thresholds/1.0`), its loader check, and the store ID.
// Design section 5 §10.4 (an outcome needs more confidence than a handler) and section 8 §14.1.
import { describe, expect, test } from "vitest";
import { thresholdsKind } from "../../../src/core/model/kinds.js";
import {
  checkThresholds,
  DEFAULT_CUTOFFS,
  Thresholds,
} from "../../../src/core/model/thresholds.js";

const base = {
  schema: "intyy.thresholds/1.0",
  app: "kvfcu",
  jev_version: "jev@fake",
  revision: 1,
  handler_min: 0.8,
  outcome_min: 0.95,
  reconciliation_min: 0.9,
};

describe("Thresholds", () => {
  test("accepts the starting values", () => {
    expect(Thresholds.safeParse(base).success).toBe(true);
    expect(DEFAULT_CUTOFFS).toEqual({
      handler_min: 0.8,
      outcome_min: 0.95,
      reconciliation_min: 0.9,
    });
  });

  test("accepts 0 and 1 (at 1.0 jev can never reach that answer)", () => {
    expect(Thresholds.safeParse({ ...base, outcome_min: 1, handler_min: 0 }).success).toBe(true);
  });

  test("rejects a cutoff above 1 or below 0, an extra field, and a bad revision", () => {
    expect(Thresholds.safeParse({ ...base, handler_min: 1.01 }).success).toBe(false);
    expect(Thresholds.safeParse({ ...base, handler_min: -0.1 }).success).toBe(false);
    expect(Thresholds.safeParse({ ...base, extra: true }).success).toBe(false);
    expect(Thresholds.safeParse({ ...base, revision: 0 }).success).toBe(false);
  });

  test("rejects a jev version that could climb out of the store path", () => {
    expect(Thresholds.safeParse({ ...base, jev_version: "../x" }).success).toBe(false);
  });
});

describe("checkThresholds", () => {
  test("passes the starting values, and equal cutoffs", () => {
    expect(checkThresholds(Thresholds.parse(base))).toEqual([]);
    expect(checkThresholds(Thresholds.parse({ ...base, outcome_min: 0.8 }))).toEqual([]);
  });

  test("flags outcome_min below handler_min", () => {
    const problems = checkThresholds(Thresholds.parse({ ...base, outcome_min: 0.7 }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("outcome_min");
  });
});

describe("thresholdsKind", () => {
  test("the store ID is <app>/<jev_version>, and the revision is the file revision", () => {
    const doc = Thresholds.parse(base);
    expect(thresholdsKind.idOf?.(doc)).toBe("kvfcu/jev@fake");
    expect(thresholdsKind.revOf(doc)).toBe("1");
  });
});
