// The fixture suite: the CI rules of design section 5 §13.4, plus the §13.3 minimum-set check.
// Runs the real condition evaluator and clue voter (`src/core/targets/`) against saved, masked
// captures, so a fixture tests the same code path as a live replay (section 5 §13.2).
import { evaluate, type EvalCtx } from "../targets/evaluate.js";
import { fromA11ySnapshot } from "../targets/a11y-snapshot.js";
import type { ScreenView } from "../targets/screen.js";
import { vote } from "../targets/vote.js";
import type { Fixture } from "../model/fixture.js";
import type { Handler, PackCondition, PackTarget } from "../model/pack.js";
import { breakTie, type FrozenSet } from "./merge.js";

/** One fixture's saved `a11y.yaml` text, read back by the caller (`src/core/` reads no files). */
export type LoadedFixture = { fixture: Fixture; a11y: string };

/** One fixture-suite problem (section 5 §13.4, §13.3). */
export type FixtureSuiteProblem = { readonly code: string; readonly handlerId: string; readonly message: string };

/** A saved fixture as a {@link ScreenView} (section 5 §13.2). `boxes`, when present, fills each
 * numbered element's `region` clue; `fromA11ySnapshot` numbers elements "0", "1", … in order. */
function screenOf(loaded: LoadedFixture): ScreenView {
  const base = fromA11ySnapshot(loaded.a11y, loaded.fixture.location);
  const boxes = loaded.fixture.boxes;
  if (boxes === undefined) return base;
  return {
    ...base,
    elements: base.elements.map((el) => {
      const box = boxes[el.id];
      return box === undefined ? el : { ...el, region: box };
    }),
  };
}

/** Answers one handler's detector against one screen. */
function fires(handler: Handler, screen: ScreenView, ctx: EvalCtx): boolean {
  const detector = ctx.conditions?.get(handler.detector);
  if (detector === undefined) throw new Error(`${handler.id}'s detector ${handler.detector} is not a known condition`);
  return evaluate(detector, screen, ctx) === "true";
}

/** True when `handler`'s detector matches `loaded` (section 5 §6.3). For `pack dry-run
 * --fixtures` (section 9 §8.5): "which detectors fire on which screens", one pair at a time. */
export function handlerFiresOn(
  handler: Handler,
  targets: readonly PackTarget[],
  conditions: readonly PackCondition[],
  loaded: LoadedFixture,
): boolean {
  return fires(handler, screenOf(loaded), ctxOf(targets, conditions));
}

/** Same check, straight from a masked accessibility snapshot's own text and location, with no
 * fixture file on disk (section 6 §15's table, "adopted pack outcome"): `candidate adopt`
 * checks a handler fires on a negative run's own saved screen before it adopts it. */
export function handlerFiresOnScreen(
  handler: Handler,
  targets: readonly PackTarget[],
  conditions: readonly PackCondition[],
  a11y: string,
  location: string,
): boolean {
  return fires(handler, fromA11ySnapshot(a11y, location), ctxOf(targets, conditions));
}

/** Builds the shared {@link EvalCtx} once: targets and conditions by ID. `PackTarget` and
 * `PackCondition` carry every field their artifact counterparts do, plus an optional
 * `overrides` flag the evaluator and voter never read. */
function ctxOf(targets: readonly PackTarget[], conditions: readonly PackCondition[]): EvalCtx {
  return {
    targets: new Map(targets.map((t) => [t.id, t])),
    conditions: new Map(conditions.map((c) => [c.id, c])),
  };
}

/**
 * Runs the section 5 §13.4 CI rules and the §13.3 minimum-set check over one handler set and
 * its fixtures (own fixtures plus every other handler's `fire` fixtures, the negative library
 * of §13.4). `scoped`, when given, lets rule 2 use the real tie rule (section 5 §7.6) instead of
 * flagging every double match; omit it to check one handler set with no scope information (a
 * lone candidate pack, still worth checking on its own fixtures).
 */
export function checkFixtureSuite(
  handlers: readonly Handler[],
  targets: readonly PackTarget[],
  conditions: readonly PackCondition[],
  fixtures: readonly LoadedFixture[],
  scoped?: Pick<FrozenSet, "handlers" | "handlerScope">,
): FixtureSuiteProblem[] {
  const problems: FixtureSuiteProblem[] = [];
  const ctx = ctxOf(targets, conditions);
  const byId = new Map(fixtures.map((f) => [f.fixture.id, f] as const));

  // Section 5 §13.3: every handler needs at least one fire and one no_fire fixture.
  for (const h of handlers) {
    if (h.fixtures.fire.length === 0) problems.push({ code: "no_fire_fixture", handlerId: h.id, message: `${h.id} has no fire fixture` });
    if (h.fixtures.no_fire.length === 0) {
      problems.push({ code: "no_no_fire_fixture", handlerId: h.id, message: `${h.id} has no no_fire fixture` });
    }
  }

  // CI rule 1: no detector matches a normal fixture.
  for (const loaded of fixtures) {
    if (loaded.fixture.kind !== "normal") continue;
    const screen = screenOf(loaded);
    for (const h of handlers) {
      if (fires(h, screen, ctx)) {
        problems.push({
          code: "fires_on_normal",
          handlerId: h.id,
          message: `${h.id}'s detector matches the normal fixture ${loaded.fixture.id}`,
        });
      }
    }
  }

  // CI rules 2 and 3: every handler's own fire fixtures, and every other handler's fire fixtures.
  for (const h of handlers) {
    for (const fixtureId of h.fixtures.fire) {
      const loaded = byId.get(fixtureId);
      if (loaded === undefined) continue; // a missing fixture file is a loader-level problem, not this suite's
      const screen = screenOf(loaded);
      if (!fires(h, screen, ctx)) {
        problems.push({ code: "detector_does_not_fire", handlerId: h.id, message: `${h.id}'s detector does not match its own fire fixture ${fixtureId}` });
      } else if (h.class === "recoverable") {
        // Rule 3: every response target has a clear winner on this screen.
        for (const [i, action] of h.response.entries()) {
          if (action.type !== "click" && action.type !== "type" && action.type !== "select" && action.type !== "set_checked") continue;
          const target = ctx.targets.get(action.target);
          if (target === undefined) continue; // a dangling target is a loader-level problem
          const v = vote(target, screen, ctx.targets);
          if (v.kind !== "winner") {
            problems.push({
              code: "response_target_not_clear",
              handlerId: h.id,
              message: `${h.id}'s response[${String(i)}] target ${action.target} is ${v.kind} on ${fixtureId}`,
            });
          }
        }
      }

      // Rule 2: no other handler's detector also matches this fire fixture, unless the tie
      // rule (section 5 §7.6) already picks a clear winner between the two.
      for (const other of handlers) {
        if (other.id === h.id || !fires(other, screen, ctx)) continue;
        if (scoped === undefined) {
          problems.push({
            code: "fires_on_other_fire",
            handlerId: other.id,
            message: `${other.id}'s detector also matches ${h.id}'s fire fixture ${fixtureId}, with no scope to break the tie`,
          });
          continue;
        }
        const result = breakTie([h.id, other.id], scoped);
        if ("tied" in result) {
          problems.push({
            code: "fires_on_other_fire",
            handlerId: other.id,
            message: `${other.id}'s detector also matches ${h.id}'s fire fixture ${fixtureId}, and neither scope nor priority breaks the tie`,
          });
        }
      }
    }
  }

  return problems;
}
