// Proves discovery waits for the page an action loads before the next look, and that the event
// subscription it uses is open for each dispatch and closed on every path out of `act`.
// (b) the next look sees the NEW screen when navigation events arrive; with none, the loop
// still goes on after the grace and quiet waits. (c) no subscription is left open: declined,
// blocked, gate failure, approved, secret_unavailable, aborted; none open during the approval.
// Design section 6 §10.1 step 1 (settle, capped at 10 s); section 7 §5.1 (settle after an action).
import { afterEach, describe, expect, test } from "vitest";
import { EventHub } from "../../../src/core/events/hub.js";
import { RunSpec } from "../../../src/core/model/runspec.js";
import { ManualClock } from "../../../src/fakes/clock.js";
import { ScriptedPlanner } from "../../../src/fakes/scripted-planner.js";
import { fail, ok } from "../../../src/ports/outcome.js";
import { Secret } from "../../../src/ports/secret.js";
import type { SecretBinding, Secrets } from "../../../src/ports/secrets.js";
import type { SurfaceEvent } from "../../../src/ports/surface.js";
import { SIGN_IN, SIGN_IN_STEPS, SITE, run, type Ran } from "./run-kit.js";
import { spying } from "./tap-kit.js";

const done: Ran[] = [];
afterEach(async () => {
  for (const r of done.splice(0)) await r.remove();
});

const why = { reason: "Go on.", expected: "It opens.", tag: "flow_step" };
const START = "2026-09-28T14:00:00.000Z";

/**
 * Runs with a clock that moves 50 ms per turn of the event loop, but only while the loop waits
 * on the clock. File writes then cost no fake time. `tick` gets the total fake time moved so far.
 */
async function pumped(
  opts: Omit<Parameters<typeof run>[0], "clock">,
  clock: ManualClock,
  tick: (movedMs: number) => void = () => undefined,
): Promise<Ran> {
  const end = { done: false };
  let moved = 0;
  const p = run({ ...opts, clock }).finally(() => {
    end.done = true;
  });
  while (!end.done) {
    await new Promise((r) => setImmediate(r));
    if (clock.waiting === 0) continue;
    moved += 50;
    clock.advance(50);
    tick(moved);
  }
  const r = await p;
  done.push(r);
  return r;
}

describe("settling after a dispatched action (section 7 §5.1)", () => {
  const started = (url: string): SurfaceEvent => ({ kind: "navigation_started", url });
  const finished = (url: string): SurfaceEvent => ({ kind: "navigation_done", url });

  test("navigation starts within the grace and ends later: the next look sees the new screen", async () => {
    const clock = new ManualClock(START);
    const hub = new EventHub<SurfaceEvent>();
    // The server answers late: the page starts to load 100 ms after the click, and swaps at 400 ms.
    // Both times count only while the loop waits on the clock.
    let click: (() => Promise<unknown>) | null = null;
    let clickedAt = 0;
    let moved = 0;
    let stage = 0;
    const { factory } = spying(SITE, {
      events: hub,
      onAct: (a, lease, inner) => {
        if (a.type !== "click") return inner.act(a, lease);
        click = () => inner.act(a, lease);
        clickedAt = moved;
        return Promise.resolve(ok({ dispatched: true }));
      },
    });
    const tick = (m: number): void => {
      moved = m;
      if (click === null) return;
      if (stage === 0 && m - clickedAt >= 100) {
        stage = 1;
        hub.emit(started(`${SITE.origin}/home`));
      }
      if (stage === 1 && m - clickedAt >= 400) {
        stage = 2;
        void click().then(() => { hub.emit(finished(`${SITE.origin}/home`)); });
      }
    };
    const planner = new ScriptedPlanner(SIGN_IN_STEPS);
    const r = await pumped({ surface: factory, planner }, clock, tick);
    expect(r.result).toMatchObject({ status: "success", code: null });
    expect(stage).toBe(2);
    const seen = planner.seen;
    // The click was turn 3; turn 4 is the look after it.
    expect(seen[3]?.message).toContain('<screen location="/home" title="Teller Workstation">');
  });

  test("with no navigation event the loop still goes on, after the grace and the quiet wait", async () => {
    const clock = new ManualClock(START);
    const { factory, spy } = spying(SITE, {
      clock,
      events: new EventHub<SurfaceEvent>(),
      // The page never says anything and never changes.
      onAct: (a, lease, inner) => (a.type === "click" ? Promise.resolve(ok({ dispatched: true })) : inner.act(a, lease)),
    });
    const planner = new ScriptedPlanner(SIGN_IN_STEPS);
    const r = await pumped({ surface: factory, planner }, clock);
    expect(r.result).toMatchObject({ status: "success", code: null });
    const clickAt = spy.actAt.at(-1) ?? 0;
    const nextLook = spy.lookAt.find((t) => t > clickAt) ?? clickAt;
    // Grace 500 ms, then quiet 500 ms (section 7 §5.1), before the next look.
    expect(nextLook - clickAt).toBeGreaterThanOrEqual(1000);
    expect(planner.seen[3]?.message).toContain('<screen location="/" title="Sign In">');
  });
});

describe("the subscription is closed on every path out of act (section 7 §5.1)", () => {
  const TRANSFER = RunSpec.parse({
    ...SIGN_IN,
    capability: "transfer",
    goal: "Sign in, then submit the transfer.",
    expected_effect: "commits",
    correlation: "none",
  });
  const transferSteps = [
    ...SIGN_IN_STEPS.slice(0, 3),
    { name: "click", input: { element: "e2", ...why } },
    { name: "click", input: { element: "e1", ...why } },
    { name: "done", input: { summary: "Posted.", proof: ["e1"] } },
  ];

  /** Every call opened with nothing else open, and none stays open when the run ends. */
  function expectTidy(spy: ReturnType<typeof spying>["spy"], minCalls: number): void {
    expect(spy.signals.length).toBeGreaterThanOrEqual(minCalls);
    expect(spy.openBefore.every((n) => n === 0)).toBe(true);
    expect(spy.open()).toBe(0);
  }

  async function go(opts: Parameters<typeof run>[0]): Promise<Ran> {
    const r = await run(opts);
    done.push(r);
    return r;
  }

  test("approved: none open while the human is asked; one open for the dispatch", async () => {
    const { factory, spy } = spying(SITE);
    const r = await go({
      spec: TRANSFER,
      steps: transferSteps,
      surface: factory,
      answers: [{ staff: "op_017", decision: "approve_irreversible" }],
    });
    expect(r.result.status).toBe("success");
    expect(r.operator.requests).toHaveLength(1);
    // Five dispatches (type, type, Sign In, Transfers, Submit). The approval turn used two
    // subscriptions: the first closed before the ask, the second open for the dispatch. Each
    // new subscription found none open (`expectTidy`), so none was open during the ask.
    expect(spy.openAtAct).toHaveLength(5);
    expect(spy.openAtAct.every((n) => n === 1)).toBe(true);
    expect(spy.signals).toHaveLength(6);
    expectTidy(spy, 6);
  });

  test("declined: closed, and the run goes on", async () => {
    const { factory, spy } = spying(SITE);
    const r = await go({
      spec: TRANSFER,
      steps: transferSteps,
      surface: factory,
      answers: [{ staff: "op_017", decision: "decline" }],
    });
    expect(r.operator.requests[0]).toMatchObject({ kind: "approval" });
    // Four dispatches; the declined click never dispatched, and its subscription closed before the ask.
    expect(spy.openAtAct).toHaveLength(4);
    expect(spy.signals).toHaveLength(5);
    expectTidy(spy, 5);
  });

  test("blocked by policy: closed", async () => {
    const { factory, spy } = spying(SITE);
    const r = await go({
      steps: [{ name: "navigate", input: { location: "/__test__/reset", ...why } }, ...SIGN_IN_STEPS],
      surface: factory,
    });
    expect(r.result.status).toBe("success");
    expect(spy.openAtAct).toHaveLength(3);
    expect(spy.signals).toHaveLength(4);
    expectTidy(spy, 4);
  });

  test("blocked as read-only: closed", async () => {
    const { factory, spy } = spying(SITE);
    const spec = RunSpec.parse({ ...SIGN_IN, capability: "transfer" });
    await go({ spec, steps: transferSteps, surface: factory });
    expect(spy.openAtAct).toHaveLength(4);
    expect(spy.signals).toHaveLength(5);
    expectTidy(spy, 5);
  });

  test("gate failure (the element is gone): closed", async () => {
    const { factory, spy } = spying(SITE, {
      onAct: (a, lease, inner) => {
        if (a.type !== "click") return inner.act(a, lease);
        return Promise.resolve(fail("stale_element"));
      },
    });
    const planner = new ScriptedPlanner([...SIGN_IN_STEPS.slice(0, 3), ...SIGN_IN_STEPS.slice(2)]);
    const r = await go({ surface: factory, planner });
    expect(r.result.status).toBe("success");
    expect(planner.seen[3]?.message).toContain("That element changed before the action ran.");
    expectTidy(spy, 4);
  });

  test("secret_unavailable: closed, and the run fails", async () => {
    const vanished = { on: false };
    const secretsPort: Secrets = {
      resolve: (b: SecretBinding) =>
        Promise.resolve(vanished.on ? fail("missing", b.key) : ok(new Secret("made-up-value-1"))),
    };
    const { factory, spy } = spying(SITE);
    const r = await go({
      secretsPort,
      surface: factory,
      planner: new ScriptedPlanner([
        () => {
          vanished.on = true;
          return { name: "type", input: { element: "e3", value: "{secret.operator_username}", ...why } };
        },
      ]),
    });
    expect(r.result).toMatchObject({ status: "failed", code: "secret_unavailable" });
    expectTidy(spy, 1);
  });

  test("aborted signal: the run ends and nothing stays open", async () => {
    const ctl = new AbortController();
    const { factory, spy } = spying(SITE, {
      onAct: (a, lease, inner) => {
        if (a.type === "click") ctl.abort();
        return inner.act(a, lease);
      },
    });
    const r = await go({ surface: factory, signal: ctl.signal });
    expect(r.result.status).toBe("failed");
    expectTidy(spy, 3);
  });
});
