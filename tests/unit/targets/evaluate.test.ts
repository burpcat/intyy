// Proves the condition evaluator (design section 2 §14, section 7 §6.7): each leaf's three
// answers, combining, `not` of unknown, `ref` chains, and text/location matching (section 2
// §7.3, §7.4). Names and values are made up. M04 task 5.
import { describe, expect, test } from "vitest";
import type { Condition } from "../../../src/core/model/artifact/conditions.js";
import type { Target } from "../../../src/core/model/artifact/targets.js";
import { evaluate, type AnyCheck, type EvalCtx, type EvalTrace } from "../../../src/core/targets/evaluate.js";
import type { ScreenElement, ScreenView } from "../../../src/core/targets/screen.js";

/** One screen element with defaults, for a hand-built {@link ScreenView}. */
function elem(id: string, extra: Partial<ScreenElement> = {}): ScreenElement {
  return { id, role: "generic", roleGroup: "container", path: id, visible: true, enabled: true, ...extra };
}

function view(location: string, elements: ScreenElement[]): ScreenView {
  return { location, elements };
}

function target(id: string, clues: Target["clues"]): Target {
  return { id, description: id, clues };
}

function ctxOf(...targets: Target[]): EvalCtx {
  return { targets: new Map(targets.map((t) => [t.id, t])) };
}

describe("element_visible, element_state, field_value (section 7 §6.7)", () => {
  test("a winner gives true or false by state; no winner gives false; a tie gives unknown", () => {
    const t = target("go", { role: "button", name: "Go" });
    const ambiguous = ctxOf(target("go", { role: "button", name: "Go" }));

    const found = view("/x", [elem("a", { role: "button", roleGroup: "button_like", name: "Go", enabled: false })]);
    expect(evaluate({ check: "element_visible", target: "go" }, found, ctxOf(t))).toBe("true");
    expect(evaluate({ check: "element_state", target: "go", state: "disabled" }, found, ctxOf(t))).toBe(
      "true",
    );
    expect(evaluate({ check: "element_state", target: "go", state: "enabled" }, found, ctxOf(t))).toBe(
      "false",
    );

    const missing = view("/x", [elem("a", { role: "generic", roleGroup: "container" })]);
    expect(evaluate({ check: "element_visible", target: "go" }, missing, ctxOf(t))).toBe("false");

    const tied = view("/x", [
      elem("a", { role: "button", roleGroup: "button_like", name: "Go" }),
      elem("b", { role: "button", roleGroup: "button_like", name: "Go" }),
    ]);
    const trace: EvalTrace = [];
    expect(evaluate({ check: "element_visible", target: "go" }, tied, ambiguous, trace)).toBe(
      "unknown",
    );
    expect(trace).toEqual(["target ambiguous"]);
  });

  test("element_state checked/unchecked/selected: unknown, not false, when not observable", () => {
    // Why no `role` clue: the point here is `checked`/`selected` observability, not the role
    // filter, so both a checkbox and a plain button must stay candidates for the same target.
    const t = target("go", { name: "Go" });
    // A checkbox with a known checked state: observable, answers true or false.
    const checkbox = view("/x", [
      elem("a", { role: "checkbox", roleGroup: "check", name: "Go", checked: true }),
    ]);
    expect(evaluate({ check: "element_state", target: "go", state: "checked" }, checkbox, ctxOf(t))).toBe(
      "true",
    );
    expect(evaluate({ check: "element_state", target: "go", state: "unchecked" }, checkbox, ctxOf(t))).toBe(
      "false",
    );

    // A plain button carries no checked or selected value at all: not observable.
    const button = view("/x", [elem("a", { role: "button", roleGroup: "button_like", name: "Go" })]);
    const traceChecked: EvalTrace = [];
    expect(
      evaluate({ check: "element_state", target: "go", state: "checked" }, button, ctxOf(t), traceChecked),
    ).toBe("unknown");
    expect(traceChecked).toEqual(["value not observable"]);
    const traceUnchecked: EvalTrace = [];
    expect(
      evaluate(
        { check: "element_state", target: "go", state: "unchecked" },
        button,
        ctxOf(t),
        traceUnchecked,
      ),
    ).toBe("unknown");
    expect(traceUnchecked).toEqual(["value not observable"]);
    const traceSelected: EvalTrace = [];
    expect(
      evaluate(
        { check: "element_state", target: "go", state: "selected" },
        button,
        ctxOf(t),
        traceSelected,
      ),
    ).toBe("unknown");
    expect(traceSelected).toEqual(["value not observable"]);
  });

  test("field_value: true or false by value; unknown with no observed value (owner decision)", () => {
    const t = target("box", { role: "textbox", label: "Member ID" });
    const withValue = view("/x", [
      elem("a", { role: "textbox", roleGroup: "text_entry", label: "Member ID", fieldValue: "137" }),
    ]);
    expect(
      evaluate(
        { check: "field_value", target: "box", value: "137", match: "exact" },
        withValue,
        ctxOf(t),
      ),
    ).toBe("true");
    expect(
      evaluate(
        { check: "field_value", target: "box", value: "138", match: "exact" },
        withValue,
        ctxOf(t),
      ),
    ).toBe("false");

    const noValue = view("/x", [elem("a", { role: "textbox", roleGroup: "text_entry", label: "Member ID" })]);
    const trace: EvalTrace = [];
    expect(
      evaluate(
        { check: "field_value", target: "box", value: "137", match: "exact" },
        noValue,
        ctxOf(t),
        trace,
      ),
    ).toBe("unknown");
    expect(trace).toEqual(["value not observable"]);
  });
});

describe("text_visible and location (section 2 §7.3 wildcards, §7.4 normalizing)", () => {
  test("text_visible matches, trims, collapses spaces, and ignores case by default", () => {
    const found = view("/x", [elem("a", { text: "  No   Member Found  " })]);
    expect(
      evaluate(
        { check: "text_visible", text: "no member found", match: "exact" },
        found,
        ctxOf(),
      ),
    ).toBe("true");
    expect(
      evaluate({ check: "text_visible", text: "not there", match: "contains" }, found, ctxOf()),
    ).toBe("false");
  });

  test("text_visible wildcard: * matches any run of characters, even across words", () => {
    const found = view("/x", [elem("a", { text: "Account 100107 opened" })]);
    expect(
      evaluate(
        { check: "text_visible", text: "Account*opened", match: "wildcard" },
        found,
        ctxOf(),
      ),
    ).toBe("true");
  });

  test("location matches a path pattern; * never crosses /", () => {
    const shallow = view("/members/100107", []);
    expect(evaluate({ check: "location", pattern: "/members/*" }, shallow, ctxOf())).toBe(
      "true",
    );
    const deep = view("/members/100107/accounts", []);
    expect(evaluate({ check: "location", pattern: "/members/*" }, deep, ctxOf())).toBe(
      "false",
    );
    expect(
      evaluate({ check: "location", pattern: "/members/*/accounts" }, deep, ctxOf()),
    ).toBe("true");
    const deeper = view("/members/100107/accounts/9", []);
    expect(
      evaluate({ check: "location", pattern: "/members/*/accounts" }, deeper, ctxOf()),
    ).toBe("false");
  });
});

describe("combining (section 2 §14.5, section 7 §6.7)", () => {
  const alwaysTrue: AnyCheck = { check: "location", pattern: "/x" };
  const alwaysFalse: AnyCheck = { check: "location", pattern: "/y" };
  const unknownLeaf: AnyCheck = { check: "element_visible", target: "tied" };
  const on = view("/x", [
    elem("a", { role: "button", roleGroup: "button_like", name: "Go" }),
    elem("b", { role: "button", roleGroup: "button_like", name: "Go" }),
  ]);
  const ctx = ctxOf(target("tied", { role: "button", name: "Go" }));

  test("all_of: false wins over unknown; unknown wins over true", () => {
    expect(evaluate({ check: "all_of", checks: [alwaysTrue, alwaysFalse, unknownLeaf] }, on, ctx)).toBe(
      "false",
    );
    expect(evaluate({ check: "all_of", checks: [alwaysTrue, unknownLeaf] }, on, ctx)).toBe("unknown");
    expect(evaluate({ check: "all_of", checks: [alwaysTrue, alwaysTrue] }, on, ctx)).toBe("true");
  });

  test("any_of: true wins over unknown; unknown wins over false", () => {
    expect(evaluate({ check: "any_of", checks: [alwaysTrue, alwaysFalse, unknownLeaf] }, on, ctx)).toBe(
      "true",
    );
    expect(evaluate({ check: "any_of", checks: [alwaysFalse, unknownLeaf] }, on, ctx)).toBe("unknown");
    expect(evaluate({ check: "any_of", checks: [alwaysFalse, alwaysFalse] }, on, ctx)).toBe("false");
  });

  test("not of unknown is unknown, and never passes as true", () => {
    expect(evaluate({ check: "not", of: unknownLeaf }, on, ctx)).toBe("unknown");
    expect(evaluate({ check: "not", of: alwaysFalse }, on, ctx)).toBe("true");
    expect(evaluate({ check: "not", of: alwaysTrue }, on, ctx)).toBe("false");
  });

  test("ref resolves to a named condition, chains included", () => {
    const base: Condition = { id: "on_page", description: "on page x", check: "location", pattern: "/x" };
    const chained: Condition = { id: "chained", description: "chains to on_page", ref: "on_page" };
    const conditions = new Map<string, Condition>([
      ["on_page", base],
      ["chained", chained],
    ]);
    const withRefs: EvalCtx = { ...ctx, conditions };
    expect(evaluate({ ref: "chained" }, on, withRefs)).toBe("true");
  });
});
