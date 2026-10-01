// Proves the live classifier puts every finished run in the right class (design section 8 §12.1
// which runs count, §12.2 failure codes by class, §5.5 live lines, §12.4 `timeout_pressure` input):
// each recipe code is a `recipe_failure`, each app code an `app_failure`, each intyy or human code,
// a rejection, and an escalation `not_counted`; a commit that ends `uncertain` is a recipe failure
// whatever else happened; a success with a rung 3 line or a takeover for `stuck` or `unsafe_state`
// is `assisted`, while rung 2, a takeover for `needs_human_handler`, an approval, and a start
// confirmation stay `clean`; a prelude failure blames the session key and leaves the task line
// `not_counted`; margins keep the lowest per target; `step_ms` skips a laddered step. Pure: no
// files, no clock. M11 task 1.
import { describe, expect, test } from "vitest";
import { classOfCode, liveLinesOf, readEvents, type RunForLive } from "../../../src/core/trust/live-class.js";
import type { Result } from "../../../src/core/model/result.js";
import { h } from "./kit.js";
import {
  at,
  escalated,
  ev,
  failed,
  intervention,
  ladder,
  outcome,
  rejected,
  runEnd,
  runId,
  stepEnd,
  success,
  vote,
} from "./live-kit.js";

const RECIPE = [
  "precondition_failed",
  "target_not_found",
  "target_ambiguous",
  "action_blocked",
  "action_failed",
  "checkpoint_timeout",
  "output_parse_failed",
  "run_timeout",
  "undeclared_outcome",
  "outputs_unavailable",
];
const APP = ["app_unreachable", "session_lost", "app_error", "permission_denied"];
const NOT_COUNTED = ["internal_error", "evidence_write_failed", "secret_unavailable", "handler_set_invalid", "ended_by_operator", "escalation_timeout"];

/** The lines one run writes. */
function linesOf(result: Result, events: unknown[] = [], over: Partial<RunForLive> = {}) {
  return liveLinesOf({
    runId: runId(1),
    at: at(1),
    mode: "unattended",
    kind: "replay",
    result,
    events,
    under: { engine: "0.4.0", handler_set: h("handlers"), jev: null },
    ...over,
  });
}

/** The task line's class for a run. */
const classOf = (result: Result, events: unknown[] = []) => linesOf(result, events).main.class;

describe("classOfCode: section 8 §12.2", () => {
  test.each(RECIPE)("%s is a recipe failure", (code) => {
    expect(classOfCode(code)).toBe("recipe_failure");
  });
  test.each(APP)("%s is an app failure", (code) => {
    expect(classOfCode(code)).toBe("app_failure");
  });
  test.each(NOT_COUNTED)("%s is not counted", (code) => {
    expect(classOfCode(code)).toBe("not_counted");
  });
});

describe("a failed run: the line carries the code and step", () => {
  test.each(RECIPE)("%s gives a recipe_failure task line", (code) => {
    const main = linesOf(failed(code, "click_search"), [runEnd("click_search", "failed", code)]).main;
    expect(main).toMatchObject({ as: "task", class: "recipe_failure", code, step: "click_search" });
  });
  test.each(APP)("%s gives an app_failure task line", (code) => {
    expect(linesOf(failed(code), [runEnd("click_search")]).main).toMatchObject({ class: "app_failure", code });
  });
  test.each(NOT_COUNTED)("%s gives a not_counted task line", (code) => {
    expect(linesOf(failed(code), [runEnd("click_search")]).main).toMatchObject({ class: "not_counted", code });
  });
  test("a rejected run and an escalated run are not counted, with no code", () => {
    expect(linesOf(rejected()).main).toMatchObject({ class: "not_counted", code: null, step: null });
    expect(linesOf(escalated()).main).toMatchObject({ class: "not_counted", code: null, step: null });
  });
  test("the line holds the run, the end time, the mode, and what the run ran under", () => {
    const main = linesOf(failed("action_failed"), [], { mode: "supervised" }).main;
    expect(main).toMatchObject({
      run_id: runId(1),
      at: at(1),
      mode: "supervised",
      under: { engine: "0.4.0", handler_set: h("handlers"), jev: null },
    });
  });
});

describe("commit uncertain: when unsure, assume the worst (section 8 §12.1)", () => {
  test("a success whose commit ends uncertain is a recipe failure", () => {
    const main = linesOf(success({ effect: { commit: "uncertain" } }), [runEnd("click_confirm", "success")]).main;
    expect(main).toMatchObject({ class: "recipe_failure", step: "click_confirm" });
  });
  test("a failed run with an intyy code and an uncertain commit is a recipe failure, not not_counted", () => {
    expect(classOf(failed("internal_error", "click_confirm", { effect: { commit: "uncertain" } }))).toBe("recipe_failure");
  });
  test("an uncertain commit beats an app code too", () => {
    expect(classOf(failed("app_error", "click_confirm", { effect: { commit: "uncertain" } }))).toBe("recipe_failure");
  });
  test("a confirmed commit changes nothing", () => {
    expect(classOf(success({ effect: { commit: "confirmed" } }))).toBe("clean");
  });
});

describe("success: clean or assisted (section 8 §12.1)", () => {
  test("a plain success is clean, with no code and no step", () => {
    expect(linesOf(success()).main).toMatchObject({ class: "clean", code: null, step: null });
    expect(classOf(outcome("code"))).toBe("clean");
  });
  test("a rung 3 ladder line makes it assisted", () => {
    expect(classOf(success(), [ladder("click_search", 3)])).toBe("assisted");
  });
  test("a rung 3 action by the reviewer makes it assisted", () => {
    expect(classOf(success(), [ev("action", "click_search", {}, "reviewer")])).toBe("assisted");
  });
  test("a recovery through the reviewer makes it assisted", () => {
    const recovery = { step: "click_search", rung: 3, via: "reviewer", ref: "r", resumed_at: "click_search", at: at(0) };
    expect(classOf(success({ recoveries: [recovery] }))).toBe("assisted");
  });
  test("rung 1 and rung 2 are not help", () => {
    expect(classOf(success(), [ladder("click_search", 1), ladder("click_search", 2)])).toBe("clean");
  });
  test("an outcome decided by jev or a human is assisted", () => {
    expect(classOf(outcome("jev"))).toBe("assisted");
    expect(classOf(outcome("human"))).toBe("assisted");
  });
  test("a reconciliation check decided by jev or a human is assisted", () => {
    const check = (decided_by: string) => success({ effect: { commit: "found_by_check", check: { run_id: runId(2), decided_by, staff_id: null } } });
    expect(classOf(check("jev"))).toBe("assisted");
    expect(classOf(check("human"))).toBe("assisted");
    expect(classOf(check("code"))).toBe("clean");
  });
  test.each(["stuck", "unsafe_state"])("a takeover for %s is assisted", (reason) => {
    expect(classOf(success({ interventions: [intervention("takeover", reason, "click_search", "handed_back")] }))).toBe("assisted");
  });
  test("a takeover for a needs_human handler is clean", () => {
    expect(classOf(success({ interventions: [intervention("takeover", "needs_human_handler", "click_search", "handed_back")] }))).toBe("clean");
  });
  test("an approval and a start confirmation are the design working, so clean", () => {
    const ints = [intervention("approval", "bank_requires_approval"), intervention("start_confirmation", "supervised_mode", null)];
    expect(classOf(success({ interventions: ints }))).toBe("clean");
  });
});

describe("prelude failures and prelude lines (section 8 §5.5)", () => {
  test("a failure inside the prelude blames the session key: its line fails, the task line is not counted", () => {
    const lines = linesOf(failed("target_not_found", "click_login"), [runEnd("session:click_login", "failed", "target_not_found")]);
    expect(lines.main).toMatchObject({ as: "task", class: "not_counted", step: null });
    expect(lines.prelude).toMatchObject({ as: "prelude", class: "recipe_failure", code: "target_not_found", step: "click_login", run_id: runId(1) });
  });
  test("an app failure in the prelude is an app failure for the session key only", () => {
    const lines = linesOf(failed("session_lost", "click_login"), [runEnd("session:click_login", "failed", "session_lost")]);
    expect(lines.main.class).toBe("not_counted");
    expect(lines.prelude).toMatchObject({ class: "app_failure", code: "session_lost" });
  });
  test("a prelude that ran gives the session key a clean line; the task keeps its own class", () => {
    const events = [stepEnd("session:click_login", 800), stepEnd("click_search", 900)];
    const lines = linesOf(failed("target_not_found"), [...events, runEnd("click_search")]);
    expect(lines.prelude).toMatchObject({ as: "prelude", class: "clean", code: null });
    expect(lines.main).toMatchObject({ class: "recipe_failure", step: "click_search" });
  });
  test("a rung 3 line inside the prelude makes the session line assisted and leaves the task clean", () => {
    const lines = linesOf(success(), [ladder("session:click_login", 3)]);
    expect(lines.prelude?.class).toBe("assisted");
    expect(lines.main.class).toBe("clean");
  });
  test("a run with no prelude steps writes no prelude line", () => {
    expect(linesOf(success(), [stepEnd("click_search", 900)]).prelude).toBeNull();
  });
  test("a reconciliation child writes a check line for its own key", () => {
    expect(linesOf(success(), [], { kind: "reconciliation" }).main.as).toBe("check");
  });
});

describe("margins, differing clues, and step times", () => {
  test("margins keep the lowest per target, split by task and prelude", () => {
    const events = [
      vote("type_member_id", "member_id_box", 0.8),
      vote("click_search", "search_button", 0.5),
      vote("click_search_again", "search_button", 0.3),
      vote("click_confirm", "confirm_button", 1),
    ];
    const main = linesOf(success(), events).main;
    expect(main.margins).toEqual({ member_id_box: 0.8, search_button: 0.3, confirm_button: 1 });
  });
  test("differing keeps the clue names per target, once each, in order", () => {
    const events = [vote("a", "t1", 0.5, ["text", "label"]), vote("b", "t1", 0.4, ["text", "role"]), vote("c", "t2", 1)];
    expect(linesOf(success(), events).main.differing).toEqual({ t1: ["label", "role", "text"] });
  });
  test("step_ms holds each step's clean time", () => {
    const main = linesOf(success(), [stepEnd("a", 120), stepEnd("b", 340)]).main;
    expect(main.step_ms).toEqual({ a: 120, b: 340 });
  });
  test("step_ms skips a step that has a ladder line, wherever the line sits", () => {
    const before = linesOf(success(), [ladder("b", 1), stepEnd("a", 120), stepEnd("b", 340)]).main;
    const after = linesOf(success(), [stepEnd("a", 120), stepEnd("b", 340), ladder("b", 1)]).main;
    expect(before.step_ms).toEqual({ a: 120 });
    expect(after.step_ms).toEqual({ a: 120 });
  });
  test("a prelude step's time is not on the task line", () => {
    expect(linesOf(success(), [stepEnd("session:x", 50), stepEnd("a", 120)]).main.step_ms).toEqual({ a: 120 });
  });
  test("a log line it cannot read is skipped, not fatal", () => {
    const facts = readEvents([null, 5, "x", { event: 3 }, vote("a", "t", 0.7)]);
    expect(facts.task.margins).toEqual({ t: 0.7 });
  });
});
