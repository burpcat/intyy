// Proves the error ladder's pure logic: the helper window matrix (design section 5 §8.2), the
// resume rule (§8.6), and the location-only precondition rule for "known screen, no progress"
// (docs/decisions.md, M06). No surface, no gate: every input is a hand-built `ScreenView` or
// `Condition` map, the same style `wait.test.ts` uses for its own pure checks. M06 task 2/3.
import { describe, expect, test } from "vitest";
import type { Condition } from "../../../src/core/model/artifact/conditions.js";
import type { Handler } from "../../../src/core/model/pack.js";
import type { RiskKind } from "../../../src/core/model/artifact/steps.js";
import type { EvalCtx } from "../../../src/core/targets/evaluate.js";
import type { ScreenView } from "../../../src/core/targets/screen.js";
import {
  helperWindow,
  isLocationOnly,
  matchDetectors,
  resumeSearch,
  type LadderStep,
} from "../../../src/core/replay/ladder.js";

/** A screen at `location`, with `elements`. */
function screen(location: string, elements: ScreenView["elements"] = []): ScreenView {
  return { location, elements };
}

/** One named location condition. */
function locationCondition(id: string, pattern: string): Condition {
  return { id, description: id, check: "location", pattern };
}

/** One named text condition, never a location check. */
function textCondition(id: string, text: string): Condition {
  return { id, description: id, check: "text_visible", text, match: "contains" };
}

describe("helperWindow (section 5 §8.2)", () => {
  test.each<[RiskKind, boolean | "unknown", "open" | "closed"]>([
    // idempotent + any dispatched: open.
    ["idempotent", true, "open"],
    ["idempotent", false, "open"],
    ["idempotent", "unknown", "open"],
    // reversible/irreversible + dispatched true or "unknown": closed.
    ["reversible", true, "closed"],
    ["reversible", "unknown", "closed"],
    ["irreversible", true, "closed"],
    ["irreversible", "unknown", "closed"],
    // any risk + dispatched false: open (nothing was sent at all, section 7 §7.2).
    ["reversible", false, "open"],
    ["irreversible", false, "open"],
  ])("risk %s, dispatched %s -> %s", (risk, dispatched, want) => {
    expect(helperWindow(risk, dispatched)).toBe(want);
  });
});

describe("isLocationOnly (docs/decisions.md, M06)", () => {
  test("a bare location condition is location-only", () => {
    const conditions = new Map([["loc", locationCondition("loc", "/main")]] as const);
    expect(isLocationOnly("loc", conditions)).toBe(true);
  });

  test("all_of of only location checks is location-only", () => {
    const c: Condition = {
      id: "both",
      description: "both",
      check: "all_of",
      checks: [{ check: "location", pattern: "/main" }, { check: "location", pattern: "/main" }],
    };
    const conditions = new Map([["both", c]] as const);
    expect(isLocationOnly("both", conditions)).toBe(true);
  });

  test("any_of mixing a location leaf with a text leaf is not location-only", () => {
    const c: Condition = {
      id: "mixed",
      description: "mixed",
      check: "any_of",
      checks: [{ check: "location", pattern: "/main" }, { check: "text_visible", text: "Hi", match: "contains" }],
    };
    const conditions = new Map([["mixed", c]] as const);
    expect(isLocationOnly("mixed", conditions)).toBe(false);
  });

  test("a ref chain to a location condition is location-only", () => {
    const loc = locationCondition("loc", "/main");
    const c: Condition = { id: "via_ref", description: "via_ref", check: "ref", ref: "loc" };
    const conditions = new Map([
      ["loc", loc],
      ["via_ref", c],
    ]);
    expect(isLocationOnly("via_ref", conditions)).toBe(true);
  });

  test("a plain text condition is never location-only", () => {
    const conditions = new Map([["txt", textCondition("txt", "Hello")]] as const);
    expect(isLocationOnly("txt", conditions)).toBe(false);
  });
});

describe("matchDetectors (section 5 §7.6, §8.3, §8.4 step 3)", () => {
  function handlerWith(id: string, detector: string): Handler {
    return {
      class: "recoverable",
      id,
      description: id,
      detector,
      fixtures: { fire: [], no_fire: [] },
      response: [],
      limits: { per_step: 3, per_run: 6 },
      on_exhausted: { class: "hard_failure", failure: "app_error" },
    };
  }

  test("returns every handler whose detector matches, and only those", () => {
    const conditions = new Map([
      ["a_shown", textCondition("a_shown", "A is showing")],
      ["b_shown", textCondition("b_shown", "B is showing")],
    ]);
    const ctx: EvalCtx = { targets: new Map(), conditions };
    const s = screen("/main", [
      { id: "el1", role: "generic", roleGroup: "container", path: "el1", visible: true, enabled: true, text: "A is showing" },
    ]);
    const handlers = [handlerWith("h_a", "a_shown"), handlerWith("h_b", "b_shown")];
    expect(matchDetectors(handlers, s, ctx)).toEqual(["h_a"]);
  });

  test("no handler matches: an empty list", () => {
    const conditions = new Map([["a_shown", textCondition("a_shown", "A is showing")]]);
    const ctx: EvalCtx = { targets: new Map(), conditions };
    const s = screen("/main", []);
    expect(matchDetectors([handlerWith("h_a", "a_shown")], s, ctx)).toEqual([]);
  });
});

describe("resumeSearch (section 5 §8.6)", () => {
  const A: LadderStep = { id: "a", precondition: "a_pre", checkpoint: "a_cp", risk: "idempotent" };
  const B: LadderStep = { id: "b", precondition: "b_pre", checkpoint: "b_cp", risk: "idempotent" };
  const C: LadderStep = { id: "c", precondition: "c_pre", checkpoint: "c_cp", risk: "idempotent" };
  const steps = [A, B, C];

  /** Every step's precondition and checkpoint is a `text_visible` check for its own ID: a fake
   * screen "passes" exactly the conditions whose ID text it shows (see `screenPassing`). */
  function ctx(): EvalCtx {
    const conditions = new Map<string, Condition>();
    for (const id of ["a_pre", "a_cp", "b_pre", "b_cp", "c_pre", "c_cp"]) {
      conditions.set(id, { id, description: id, check: "text_visible", text: id, match: "contains" });
    }
    return { targets: new Map(), conditions };
  }

  /** A screen whose elements make exactly `passingIds`' text conditions pass. */
  function screenPassing(passingIds: readonly string[]): ScreenView {
    return screen(
      "/main",
      passingIds.map((id, i) => ({
        id: `el${String(i)}`,
        role: "generic",
        roleGroup: "container",
        path: `el${String(i)}`,
        visible: true,
        enabled: true,
        text: id,
      })),
    );
  }

  test("checkpoint now passes: continue", () => {
    const r = resumeSearch(steps, 1, true, 0, screenPassing(["b_cp"]), ctx());
    expect(r).toEqual({ kind: "continue" });
  });

  test("unchanged screen: resumes at the same failed step", () => {
    // The failed step's own precondition still passes (nothing moved), and it never acted.
    const r = resumeSearch(steps, 1, false, 0, screenPassing(["b_pre"]), ctx());
    expect(r).toEqual({ kind: "resume_at", index: 1 });
  });

  test("an earlier step's precondition passes now: resumes there", () => {
    const r = resumeSearch(steps, 2, false, 0, screenPassing(["a_pre"]), ctx());
    expect(r).toEqual({ kind: "resume_at", index: 0 });
  });

  test("two adjacent steps sharing one precondition: the earlier one wins", () => {
    // Both a_pre and b_pre answer true on this screen (both conditions are proven by the same
    // fake element's text; a screen with both texts present passes both).
    const shared = screen("/main", [
      { id: "e0", role: "generic", roleGroup: "container", path: "e0", visible: true, enabled: true, text: "a_pre" },
      { id: "e1", role: "generic", roleGroup: "container", path: "e1", visible: true, enabled: true, text: "b_pre" },
    ]);
    const r = resumeSearch(steps, 1, false, 0, shared, ctx());
    expect(r).toEqual({ kind: "resume_at", index: 0 });
  });

  test("a reversible step between the resume point and the failed step: not_recovered", () => {
    const risky: LadderStep = { id: "b", precondition: "b_pre", checkpoint: "b_cp", risk: "reversible" };
    const withRisky = [A, risky, C];
    const r = resumeSearch(withRisky, 2, false, 0, screenPassing(["a_pre"]), ctx());
    expect(r).toEqual({ kind: "not_recovered" });
  });

  test("nothing passes: not_recovered", () => {
    const r = resumeSearch(steps, 1, false, 0, screen("/main", []), ctx());
    expect(r).toEqual({ kind: "not_recovered" });
  });

  test("the rewind floor stops the search: not_recovered even if an earlier step would pass", () => {
    const r = resumeSearch(steps, 2, false, 2, screenPassing(["a_pre"]), ctx());
    expect(r).toEqual({ kind: "not_recovered" });
  });
});
