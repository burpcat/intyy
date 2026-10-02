// Proves condition waits and the outcome race (design section 7 §5.2, §5.3): waits end on
// state; a "not found" outcome wins early; a checkpoint/outcome overlap is marked; unknown never
// passes. M05 task 4.
import { describe, expect, test } from "vitest";
import type { Target } from "../../../src/core/model/artifact/targets.js";
import type { AnyCheck, EvalCtx } from "../../../src/core/targets/evaluate.js";
import {
  raceCheckpointAndOutcomes,
  waitForCondition,
  type RaceOutcome,
} from "../../../src/core/replay/wait.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { fail, ok, type Outcome } from "../../../src/ports/outcome.js";
import type { Eyes, Observation, SurfaceElement } from "../../../src/ports/surface.js";

/** An element ref from a plain name. */
const ref = (id: string): SurfaceElement["ref"] => id as unknown as SurfaceElement["ref"];

/** One button-like element, for a hand-built {@link Observation}. */
function button(id: string, name: string): SurfaceElement {
  return { ref: ref(id), role: "button", roleGroup: "button_like", clues: { name, path: id }, enabled: true, box: null };
}

/** One observation at `location`, with `elements`. */
function look(location: string, elements: SurfaceElement[] = []): Observation {
  return {
    url: `http://127.0.0.1:8080${location}`,
    title: "",
    page: "main",
    popups: 0,
    dialog: null,
    viewport: { width: 1280, height: 800 },
    scroll: { x: 0, y: 0 },
    elements,
  };
}

/** Eyes that answer each look from a list, repeating the last, and count their calls. */
function eyesOf(looks: Outcome<Observation, "page_gone">[]): Eyes & { calls: number } {
  const e = {
    calls: 0,
    observe: () => Promise.resolve(looks[Math.min(e.calls++, looks.length - 1)] ?? fail("page_gone")),
  };
  return e as unknown as Eyes & { calls: number };
}

const EMPTY_CTX: EvalCtx = { targets: new Map() };
const HERE: AnyCheck = { check: "location", pattern: "/here" };
const GONE: AnyCheck = { check: "text_visible", text: "Not found", match: "exact" };

describe("waitForCondition (section 7 §5.2)", () => {
  test("true on the first look ends the wait at once, with no poll", async () => {
    const eyes = eyesOf([ok(look("/here"))]);
    const r = await waitForCondition(HERE, eyes, EMPTY_CTX, 5_000, new SteppingClock());
    expect(r).toMatchObject({ ok: true, value: { answer: "true" } });
    expect(eyes.calls).toBe(1);
  });

  test("a false look becoming true ends the wait on that state, not on a timer", async () => {
    const eyes = eyesOf([ok(look("/there")), ok(look("/there")), ok(look("/here"))]);
    const r = await waitForCondition(HERE, eyes, EMPTY_CTX, 5_000, new SteppingClock());
    expect(r).toMatchObject({ ok: true, value: { answer: "true" } });
    expect(eyes.calls).toBe(3);
  });

  test("never true: the timeout returns the last answer, false or unknown, not page_gone", async () => {
    const eyes = eyesOf([ok(look("/there"))]);
    const r = await waitForCondition(HERE, eyes, EMPTY_CTX, 1_000, new SteppingClock());
    expect(r).toMatchObject({ ok: true, value: { answer: "false" } });
  });

  test("a look that never succeeds is page_gone only at the timeout", async () => {
    const eyes = eyesOf([fail("page_gone")]);
    const r = await waitForCondition(HERE, eyes, EMPTY_CTX, 1_000, new SteppingClock());
    expect(r).toMatchObject({ ok: false, failure: "page_gone" });
  });

  test("unknown never passes: an unobservable check does not end the wait early", async () => {
    const unknown: AnyCheck = { check: "element_state", target: "go", state: "checked" };
    const ctx: EvalCtx = { targets: new Map([["go", { id: "go", description: "go", clues: { name: "Go" } }]]) };
    const eyes = eyesOf([ok(look("/here", [button("a", "Go")]))]);
    const r = await waitForCondition(unknown, eyes, ctx, 1_000, new SteppingClock());
    // Why: a plain button carries no checked state at all, so this stays unknown to the cap.
    expect(r).toMatchObject({ ok: true, value: { answer: "unknown" } });
  });
});

describe("raceCheckpointAndOutcomes (section 7 §5.3)", () => {
  test("a business outcome, like 'not found', wins early: it does not wait out the checkpoint", async () => {
    const outcomes: RaceOutcome[] = [{ code: "not_found", condition: GONE }];
    const eyes = eyesOf([ok(look("/there", [{ ...button("m", "Not found") }]))]);
    const r = await raceCheckpointAndOutcomes(HERE, outcomes, eyes, EMPTY_CTX, 30_000, new SteppingClock());
    expect(r).toMatchObject({ ok: true, value: { winner: "outcome", code: "not_found", overlap: false } });
    expect(eyes.calls).toBe(1);
  });

  test("checkpoint and outcome both true on the same look: the outcome wins, marked overlap", async () => {
    const outcomes: RaceOutcome[] = [{ code: "not_found", condition: GONE }];
    const eyes = eyesOf([ok(look("/here", [{ ...button("m", "Not found") }]))]);
    const r = await raceCheckpointAndOutcomes(HERE, outcomes, eyes, EMPTY_CTX, 30_000, new SteppingClock());
    expect(r).toMatchObject({ ok: true, value: { winner: "outcome", code: "not_found", overlap: true } });
  });

  test("with no outcome true, the checkpoint wins on its own", async () => {
    const outcomes: RaceOutcome[] = [{ code: "not_found", condition: GONE }];
    const eyes = eyesOf([ok(look("/here"))]);
    const r = await raceCheckpointAndOutcomes(HERE, outcomes, eyes, EMPTY_CTX, 30_000, new SteppingClock());
    expect(r).toMatchObject({ ok: true, value: { winner: "checkpoint" } });
  });

  test("neither true by the timeout: reported as timeout, not thrown or guessed", async () => {
    const outcomes: RaceOutcome[] = [{ code: "not_found", condition: GONE }];
    const eyes = eyesOf([ok(look("/there"))]);
    const r = await raceCheckpointAndOutcomes(HERE, outcomes, eyes, EMPTY_CTX, 1_000, new SteppingClock());
    expect(r).toMatchObject({ ok: true, value: { winner: "timeout" } });
  });
});

describe("a wait measures pictures only when a picture could decide (section 7 §6.7, §6.9)", () => {
  // The recorded Search button; today it is a bare image with no name (a stripped page).
  const search: Target = {
    id: "search_button",
    description: "The button Search.",
    clues: {
      role: "button",
      name: "Search",
      region: { x: 0.5, y: 0.5, w: 0.05, h: 0.03 },
      image: "crops/search_button.png",
      path: "form > input[0]",
    },
  };
  const bareImage = (id: string, x: number): SurfaceElement => ({
    ref: ref(id),
    role: "img",
    roleGroup: "container",
    clues: { path: `form > img[${id}]` },
    enabled: true,
    box: { x, y: 400, width: 64, height: 24 },
  });
  const VISIBLE: AnyCheck = { check: "element_visible", target: "search_button" };
  const counting = (likeness: number) => {
    const asked: string[][] = [];
    const ctx: EvalCtx = {
      targets: new Map([[search.id, search]]),
      measure: (_o, ids) => {
        asked.push([...ids]);
        return Promise.resolve(new Map([["search_button", new Map([["0", likeness]])]]));
      },
    };
    return { asked, ctx };
  };

  test("a bare-image button passes element_visible once its crop is measured", async () => {
    const { asked, ctx } = counting(0.95);
    const eyes = eyesOf([ok(look("/here", [bareImage("0", 608)]))]);
    const r = await waitForCondition(VISIBLE, eyes, ctx, 5_000, new SteppingClock());
    expect(r).toMatchObject({ ok: true, value: { answer: "true" } });
    expect(asked).toEqual([["search_button"]]);
  });

  test("a different picture keeps it false", async () => {
    const { ctx } = counting(0.1);
    const eyes = eyesOf([ok(look("/here", [bareImage("0", 608)]))]);
    const r = await waitForCondition(VISIBLE, eyes, ctx, 1_000, new SteppingClock());
    expect(r).toMatchObject({ ok: true, value: { answer: "false" } });
  });

  test("no crop is taken when even a perfect picture could not win: an image far from the region", async () => {
    const { asked, ctx } = counting(1);
    const eyes = eyesOf([ok(look("/here", [bareImage("0", 10)]))]);
    const r = await waitForCondition(VISIBLE, eyes, ctx, 1_000, new SteppingClock());
    expect(r).toMatchObject({ ok: true, value: { answer: "false" } });
    expect(asked).toEqual([]);
  });

  test("no crop is taken when the plain vote already wins", async () => {
    const { asked, ctx } = counting(1);
    const named: SurfaceElement = { ...button("form > input[0]", "Search"), box: { x: 608, y: 400, width: 64, height: 24 } };
    const eyes = eyesOf([ok(look("/here", [named]))]);
    const r = await waitForCondition(VISIBLE, eyes, ctx, 1_000, new SteppingClock());
    expect(r).toMatchObject({ ok: true, value: { answer: "true" } });
    expect(asked).toEqual([]);
  });
});
