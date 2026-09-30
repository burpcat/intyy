// Proves the fixture suite (design section 5 §13.3, §13.4): the minimum-set check, and the
// three CI rules, against saved, masked accessibility snapshots. M06 task 1.
import { describe, expect, test } from "vitest";
import type { Fixture } from "../../../src/core/model/fixture.js";
import type { Handler, PackCondition, PackTarget } from "../../../src/core/model/pack.js";
import { checkFixtureSuite, handlerFiresOn, type LoadedFixture } from "../../../src/core/packs/fixture-suite.js";
import type { FrozenSet } from "../../../src/core/packs/merge.js";

/** One saved, masked screen: a heading (the trouble text) and an OK button. */
function loaded(id: string, kind: "trouble" | "normal", opts: { heading?: string; location?: string } = {}): LoadedFixture {
  const heading = opts.heading ?? "";
  const a11y = [heading === "" ? null : `- heading "${heading}"`, `- button "OK"`].filter((l): l is string => l !== null).join("\n");
  const fixture: Fixture = {
    schema: "intyy.fixture/1.0",
    id,
    app: "kvfcu",
    tenant: "keystone",
    app_version: "9.2",
    variant: "keystone",
    location: opts.location ?? "/home",
    viewport: { width: 1280, height: 800 },
    source: { run_id: "run_2026-09-30_0000000001", seq: 1 },
    kind,
  };
  return { fixture, a11y };
}

const OK_TARGET: PackTarget = { id: "ok_button", description: "OK button", clues: { role: "button", name: "OK" } };

const POPUP_SHOWN: PackCondition = {
  id: "popup_shown",
  check: "text_visible",
  description: "The popup is showing",
  text: "Trouble!",
  match: "contains",
};

/** One recoverable handler: fires on `popup_shown`, clicks the OK button. */
function handler(id: string, opts: { detector?: string; priority?: number; fire?: string[]; noFire?: string[] } = {}): Handler {
  return {
    id,
    description: "A dismissible popup.",
    class: "recoverable",
    detector: opts.detector ?? "popup_shown",
    ...(opts.priority === undefined ? {} : { priority: opts.priority }),
    response: [{ type: "click", target: "ok_button", risk: "idempotent" }],
    limits: { per_step: 1, per_run: 1 },
    on_exhausted: { class: "hard_failure", failure: "app_error" },
    fixtures: { fire: opts.fire ?? [`${id}_fire`], no_fire: opts.noFire ?? [`${id}_near_miss`] },
  };
}

describe("handlerFiresOn", () => {
  test("fires when the detector's text is on the screen", () => {
    expect(handlerFiresOn(handler("popup_handler"), [OK_TARGET], [POPUP_SHOWN], loaded("f1", "trouble", { heading: "Trouble!" }))).toBe(true);
  });

  test("does not fire on a screen with no matching text", () => {
    expect(handlerFiresOn(handler("popup_handler"), [OK_TARGET], [POPUP_SHOWN], loaded("f2", "normal"))).toBe(false);
  });
});

describe("section 5 §13.3: minimum fixture sets", () => {
  test("a handler with no fire fixture is flagged no_fire_fixture", () => {
    const h = handler("popup_handler", { fire: [] });
    const problems = checkFixtureSuite([h], [OK_TARGET], [POPUP_SHOWN], []);
    expect(problems).toContainEqual({ code: "no_fire_fixture", handlerId: "popup_handler", message: "popup_handler has no fire fixture" });
  });

  test("a handler with no no_fire fixture is flagged no_no_fire_fixture", () => {
    const h = handler("popup_handler", { noFire: [] });
    const fire = loaded("popup_handler_fire", "trouble", { heading: "Trouble!" });
    const problems = checkFixtureSuite([h], [OK_TARGET], [POPUP_SHOWN], [fire]);
    expect(problems).toContainEqual({ code: "no_no_fire_fixture", handlerId: "popup_handler", message: "popup_handler has no no_fire fixture" });
  });

  test("a handler with both kinds is not flagged for either", () => {
    const h = handler("popup_handler");
    const fixtures = [loaded("popup_handler_fire", "trouble", { heading: "Trouble!" }), loaded("popup_handler_near_miss", "normal")];
    const problems = checkFixtureSuite([h], [OK_TARGET], [POPUP_SHOWN], fixtures);
    expect(problems.map((p) => p.code)).not.toContain("no_fire_fixture");
    expect(problems.map((p) => p.code)).not.toContain("no_no_fire_fixture");
  });
});

describe("CI rule 1: no detector matches a normal fixture", () => {
  test("a handler whose detector fires on a normal fixture is flagged fires_on_normal", () => {
    const h = handler("popup_handler");
    const normal = loaded("some_normal_screen", "normal", { heading: "Trouble!" });
    const problems = checkFixtureSuite([h], [OK_TARGET], [POPUP_SHOWN], [normal]);
    expect(problems).toContainEqual({ code: "fires_on_normal", handlerId: "popup_handler", message: "popup_handler's detector matches the normal fixture some_normal_screen" });
  });

  test("a normal fixture with no matching text raises nothing", () => {
    const h = handler("popup_handler");
    const normal = loaded("some_normal_screen", "normal");
    expect(checkFixtureSuite([h], [OK_TARGET], [POPUP_SHOWN], [normal])).toEqual([]);
  });
});

describe("CI rule 3: on its own fire fixture, the detector fires and every response target is clear", () => {
  test("detector_does_not_fire when the handler's own fire fixture does not trigger it", () => {
    const h = handler("popup_handler");
    const notFiring = loaded("popup_handler_fire", "trouble");
    const problems = checkFixtureSuite([h], [OK_TARGET], [POPUP_SHOWN], [notFiring]);
    expect(problems).toContainEqual({ code: "detector_does_not_fire", handlerId: "popup_handler", message: "popup_handler's detector does not match its own fire fixture popup_handler_fire" });
  });

  test("response_target_not_clear when the click target has no clear winner on that screen", () => {
    const noOkButton: LoadedFixture = { ...loaded("popup_handler_fire", "trouble", { heading: "Trouble!" }), a11y: '- heading "Trouble!"' };
    const h = handler("popup_handler");
    const problems = checkFixtureSuite([h], [OK_TARGET], [POPUP_SHOWN], [noOkButton]);
    expect(problems.some((p) => p.code === "response_target_not_clear" && p.handlerId === "popup_handler")).toBe(true);
  });

  test("a clean fire fixture with a clear target raises neither problem", () => {
    const h = handler("popup_handler");
    const fire = loaded("popup_handler_fire", "trouble", { heading: "Trouble!" });
    const problems = checkFixtureSuite([h], [OK_TARGET], [POPUP_SHOWN], [fire]);
    expect(problems.map((p) => p.code)).not.toContain("detector_does_not_fire");
    expect(problems.map((p) => p.code)).not.toContain("response_target_not_clear");
  });
});

describe("CI rule 2: no other handler's detector also matches a fire fixture, unless the tie rule wins clearly", () => {
  test("with no scope info, any double match is flagged", () => {
    const a = handler("handler_a");
    const b = handler("handler_b");
    const fire = loaded("handler_a_fire", "trouble", { heading: "Trouble!" });
    const problems = checkFixtureSuite([a, b], [OK_TARGET], [POPUP_SHOWN], [fire]);
    expect(problems).toContainEqual({
      code: "fires_on_other_fire",
      handlerId: "handler_b",
      message: "handler_b's detector also matches handler_a's fire fixture handler_a_fire, with no scope to break the tie",
    });
  });

  test("with scope info and a clear priority winner, the tie is not flagged", () => {
    const a = handler("handler_a", { priority: 1 });
    const b = handler("handler_b", { priority: 0 });
    const fire = loaded("handler_a_fire", "trouble", { heading: "Trouble!" });
    const scoped: Pick<FrozenSet, "handlers" | "handlerScope"> = {
      handlers: [a, b],
      handlerScope: new Map([
        ["handler_a", { level: "app", app: "kvfcu" }],
        ["handler_b", { level: "app", app: "kvfcu" }],
      ]),
    };
    const problems = checkFixtureSuite([a, b], [OK_TARGET], [POPUP_SHOWN], [fire], scoped);
    expect(problems.map((p) => p.code)).not.toContain("fires_on_other_fire");
  });

  test("with scope info and still no clear winner, the tie is flagged", () => {
    const a = handler("handler_a");
    const b = handler("handler_b");
    const fire = loaded("handler_a_fire", "trouble", { heading: "Trouble!" });
    const scoped: Pick<FrozenSet, "handlers" | "handlerScope"> = {
      handlers: [a, b],
      handlerScope: new Map([
        ["handler_a", { level: "global" }],
        ["handler_b", { level: "global" }],
      ]),
    };
    const problems = checkFixtureSuite([a, b], [OK_TARGET], [POPUP_SHOWN], [fire], scoped);
    expect(problems.some((p) => p.code === "fires_on_other_fire")).toBe(true);
  });
});
