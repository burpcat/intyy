// Proves the certify gate (design section 8 §9.5): six rules, each of which fails the gate
// alone. Rule 1 full, complete, not a drill; 2 no `wrong` anywhere; 3 baseline all `pass` and the
// twin pair's traces match; 4 matrix all `pass` (an `explained` run does not count); 5 extra all
// `pass`; 6 no `void`. Drill cases are judged on truth only, so they sit under rules 2 and 6.
// A `wrong` run in the matrix fails rules 2 and 4 together, because `wrong` is not `pass`.
// M10 task 4.
import { describe, expect, test } from "vitest";
import { gatePasses, gateRules, type GateCase, type GateInput } from "../../../src/core/certify/gate.js";
import type { CaseGroup } from "../../../src/core/model/batch-plan.js";
import type { GateRules, Verdict } from "../../../src/core/model/batch-report.js";

const pass = (group: CaseGroup): GateCase => ({ group, verdict: "pass" });

/** A batch that passes every rule. */
function green(): GateInput {
  return {
    kind: "full",
    drill: false,
    complete: true,
    cases: (["baseline", "baseline", "twin", "matrix", "matrix", "extra", "drill"] as const).map(pass),
    twinMatch: true,
  };
}

/** The green batch with one case added. */
const plus = (group: CaseGroup, verdict: Verdict): GateInput => ({
  ...green(),
  cases: [...green().cases, { group, verdict }],
});

/** The rules that came out false. */
const failed = (input: GateInput): string[] =>
  Object.entries(gateRules(input)).filter(([, v]) => !v).map(([k]) => k);

describe("gate: all green", () => {
  test("every rule holds, and the gate passes", () => {
    const rules = gateRules(green());
    expect(rules).toEqual({ complete: true, no_wrong: true, baseline: true, matrix: true, extra: true, no_void: true });
    expect(gatePasses(rules)).toBe(true);
  });

  test("a batch with no extra cases and no matrix cases passes those rules", () => {
    const input: GateInput = { ...green(), cases: [pass("baseline"), pass("twin")] };
    expect(failed(input)).toEqual([]);
  });
});

describe("gate: each rule fails alone", () => {
  test.each([
    ["a quick batch", { ...green(), kind: "quick" as const }],
    ["a drill regression batch", { ...green(), kind: "regression" as const, drill: true }],
    ["an incomplete regression batch", { ...green(), kind: "regression" as const, complete: false }],
    ["a drill", { ...green(), drill: true }],
    ["an incomplete batch", { ...green(), complete: false }],
  ])("complete: %s", (_name, input) => {
    expect(failed(input)).toEqual(["complete"]);
    expect(gatePasses(gateRules(input))).toBe(false);
  });

  test("complete: a green regression batch passes (section 8 §15.1)", () => {
    const input = { ...green(), kind: "regression" as const };
    expect(gateRules(input).complete).toBe(true);
    expect(failed(input)).toEqual([]);
    expect(gatePasses(gateRules(input))).toBe(true);
  });

  test("no_wrong: one wrong in a drill case", () => {
    expect(failed(plus("drill", "wrong"))).toEqual(["no_wrong"]);
  });

  test("no_void: one void in a drill case", () => {
    expect(failed(plus("drill", "void"))).toEqual(["no_void"]);
  });

  test.each(["explained", "assisted", "unexplained"] as const)(
    "a drill case that is %s breaks no rule: drills are judged on truth only",
    (verdict) => {
      expect(failed(plus("drill", verdict))).toEqual([]);
    },
  );

  test.each(["explained", "assisted", "unexplained"] as const)("baseline: a baseline run that is %s", (verdict) => {
    expect(failed(plus("baseline", verdict))).toEqual(["baseline"]);
  });

  test("baseline: a twin run that is not pass", () => {
    expect(failed(plus("twin", "unexplained"))).toEqual(["baseline"]);
  });

  test("baseline: the twin pair's traces differ", () => {
    expect(failed({ ...green(), twinMatch: false })).toEqual(["baseline"]);
  });

  test("baseline: no twin pair ran (twinMatch null)", () => {
    expect(failed({ ...green(), twinMatch: null })).toEqual(["baseline"]);
  });

  test("baseline: no baseline case at all", () => {
    const input: GateInput = { ...green(), cases: green().cases.filter((c) => c.group !== "baseline") };
    expect(failed(input)).toEqual(["baseline"]);
  });

  test.each(["explained", "assisted", "unexplained"] as const)("matrix: a matrix run that is %s", (verdict) => {
    expect(failed(plus("matrix", verdict))).toEqual(["matrix"]);
  });

  test.each(["explained", "assisted", "unexplained"] as const)("extra: an extra run that is %s", (verdict) => {
    expect(failed(plus("extra", verdict))).toEqual(["extra"]);
  });
});

describe("gate: wrong and void in a group that must pass", () => {
  test("a wrong in the matrix fails no_wrong and matrix", () => {
    expect(failed(plus("matrix", "wrong"))).toEqual(["no_wrong", "matrix"]);
  });

  test("a wrong in the extra cases fails no_wrong and extra", () => {
    expect(failed(plus("extra", "wrong"))).toEqual(["no_wrong", "extra"]);
  });

  test("a wrong in the baseline fails no_wrong and baseline", () => {
    expect(failed(plus("baseline", "wrong"))).toEqual(["no_wrong", "baseline"]);
  });

  test("a void in the matrix fails no_void and matrix", () => {
    expect(failed(plus("matrix", "void"))).toEqual(["matrix", "no_void"]);
  });
});

describe("gatePasses", () => {
  test("any one false rule fails the gate", () => {
    const all: GateRules = gateRules(green());
    for (const name of Object.keys(all) as (keyof GateRules)[]) {
      expect(gatePasses({ ...all, [name]: false })).toBe(false);
    }
  });

  test("the report holds all six rules", () => {
    expect(Object.keys(gateRules(green())).sort()).toEqual(["baseline", "complete", "extra", "matrix", "no_void", "no_wrong"]);
  });
});
