// Proves Ctrl-C (an abort signal) during a discovery run ends it cleanly: failed, ended_by_operator,
// with run_end and run.json written and no throw. It covers an abort mid-wait, mid-settle,
// mid-model-call, and mid-session-prelude; a sent commit is still logged and counted before the
// abort ends the run; and the crash sweep finds nothing to mark internal_error afterwards.
// Real failures still end model_unavailable, and a non-abort throw still propagates.
// Design section 6 §10.4 (how a run ends); section 9 §5.7 (the clock rejects a wait on abort);
// section 7 §17 (crash sweep). docs/decisions.md, M03 (Ctrl-C ends the run ended_by_operator).
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FileEvidenceStore } from "../../../src/adapters/files/other-stores.js";
import { EventHub } from "../../../src/core/events/hub.js";
import { RunSpec } from "../../../src/core/model/runspec.js";
import { runSweep } from "../../../src/core/orchestrator/sweep.js";
import { ManualClock } from "../../../src/fakes/clock.js";
import { ScriptedPlanner, type Step } from "../../../src/fakes/scripted-planner.js";
import type { FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import type { SurfaceEvent } from "../../../src/ports/surface.js";
import { harness } from "../orchestrator/sweep-kit.js";
import { names, run, SIGN_IN, SIGN_IN_STEPS, SITE, type Ran } from "./run-kit.js";
import { LINKED_SPEC, SESSION_ARTIFACT } from "./session-kit.js";
import { spying } from "./tap-kit.js";

// Why: a run pumped on a manual clock does real file I/O between waits; a loaded machine is slow.
vi.setConfig({ testTimeout: 30_000 });

const done: Ran[] = [];
afterEach(async () => {
  for (const r of done.splice(0)) await r.remove();
});

const START = "2026-09-28T14:00:00.000Z";
const why = { reason: "Go on.", expected: "It opens.", tag: "flow_step" };

/**
 * Runs with a manual clock and an abort controller. The clock moves 250 ms each time something
 * waits on it, except when `abortWhen` says yes: then the controller aborts instead, so the abort
 * lands while a wait is open. `abortWhen` is asked only while a wait is open.
 */
async function aborted(
  ctl: AbortController,
  opts: Omit<Parameters<typeof run>[0], "clock" | "signal">,
  abortWhen: () => boolean,
): Promise<Ran> {
  const clock = new ManualClock(START);
  // An object, so TypeScript does not freeze the flag at false inside the loop.
  const end = { done: false };
  let spins = 0;
  const began = Date.now();
  const p = run({ ...opts, clock, signal: ctl.signal }).finally(() => {
    end.done = true;
  });
  while (!end.done) {
    await new Promise((r) => setImmediate(r));
    // Why: a run that never ends must fail the test, not spin forever.
    if (++spins % 1000 === 0 && Date.now() - began > 25_000) {
      ctl.abort();
      throw new Error("the run did not end");
    }
    if (clock.waiting === 0 || ctl.signal.aborted) continue;
    if (abortWhen()) ctl.abort();
    else clock.advance(250);
  }
  const r = await p;
  done.push(r);
  return r;
}

/**
 * An event hub whose read rejects, instead of just ending, when the run's own signal aborts.
 * Why: the real fake ends a read on abort, which `settleAfterAction` reads as a timeout. A
 * rejecting read is the throw these cases need: a settle that fails after the click was sent
 * (section 6 §10.4). `arm()` marks the newest subscription, the one the engine opened just
 * before the click. The run-long human-input watcher is never armed.
 */
class AbortingHub extends EventHub<SurfaceEvent> {
  readonly #subs: { armed: boolean }[] = [];

  constructor(private readonly runSignal: AbortSignal) {
    super();
  }

  /** Arms the newest subscription. A hands action calls this when the click is sent. */
  arm(): void {
    const last = this.#subs.at(-1);
    if (last !== undefined) last.armed = true;
  }

  override subscribe(signal?: AbortSignal): AsyncIterable<SurfaceEvent> {
    const inner = super.subscribe(signal);
    // The prelude subscribes with the run's own signal; the loop's tap is armed by `arm()`.
    const sub = { armed: signal === this.runSignal };
    this.#subs.push(sub);
    const runSignal = this.runSignal;
    return {
      [Symbol.asyncIterator]: () => {
        const it = inner[Symbol.asyncIterator]();
        return {
          next: async () => {
            const r = await it.next();
            if (r.done === true && runSignal.aborted && sub.armed) throw new Error("the read was aborted");
            return r;
          },
        };
      },
    };
  }
}

/** The parsed run.json of a finished run. */
function runJson(r: Ran): { status: string; code: string | null; counts: Record<string, number> | null } {
  const file = r.files.find((f) => f.path === "run.json");
  if (file === undefined) throw new Error("no run.json was written");
  return JSON.parse(new TextDecoder().decode(file.bytes)) as ReturnType<typeof runJson>;
}

/** The ended-by-operator expectations every abort case shares. */
function expectEndedByOperator(r: Ran): void {
  expect(r.result).toMatchObject({ status: "failed", code: "ended_by_operator" });
  expect(r.events.at(-1)).toMatchObject({
    event: "run_end",
    data: { status: "failed", code: "ended_by_operator" },
  });
  expect(runJson(r)).toMatchObject({ status: "failed", code: "ended_by_operator" });
}

describe("Ctrl-C ends a discovery run cleanly (section 6 §10.4)", () => {
  test("mid-wait: the planner's wait is cut short, failed ended_by_operator, no throw", async () => {
    const planner = new ScriptedPlanner([{ name: "wait", input: { ...why, seconds: 30 } }, ...SIGN_IN_STEPS]);
    const r = await aborted(new AbortController(), { planner },() => planner.seen.length >= 1);
    expectEndedByOperator(r);
    // The abort came during the turn-1 wait, so the planner was never asked again.
    expect(planner.seen).toHaveLength(1);
  });

  test("mid-settle: the page never fills, the abort lands during the settle wait", async () => {
    const empty: FakeSite = {
      ...SITE,
      screens: { ...SITE.screens, "/": { title: "Loading", elements: [] } },
    };
    const planner = new ScriptedPlanner(SIGN_IN_STEPS);
    let waits = 0;
    const r = await aborted(new AbortController(), { planner, site: empty },() => ++waits >= 3);
    expectEndedByOperator(r);
    expect(planner.seen).toHaveLength(0);
  });

  test("mid-model-call: a planner failure after the abort is not model_unavailable; no count, no retry", async () => {
    const ctl = new AbortController();
    const planner = new ScriptedPlanner([
      () => {
        ctl.abort();
        return { failure: "timeout" };
      },
      ...SIGN_IN_STEPS,
    ]);
    const r = await run({ planner, signal: ctl.signal });
    done.push(r);
    expectEndedByOperator(r);
    expect(planner.seen).toHaveLength(1);
  });

  test("regression: two real planner failures with a live signal still end model_unavailable", async () => {
    const r = await run({
      steps: [{ failure: "timeout" }, { failure: "unavailable" }],
      signal: new AbortController().signal,
    });
    done.push(r);
    expect(r.result).toMatchObject({ status: "failed", code: "model_unavailable" });
  });

  test("regression: a throw that is not an abort still propagates", async () => {
    const steps: Step[] = [
      () => {
        throw new Error("planner bug");
      },
    ];
    await expect(run({ steps, signal: new AbortController().signal })).rejects.toThrow("planner bug");
  });
});

describe("a sent action is still logged and counted when Ctrl-C lands in its settle wait (section 6 §10.4, §10.1)", () => {
  const TRANSFER = RunSpec.parse({
    ...SIGN_IN,
    capability: "transfer",
    goal: "Sign in, then submit the transfer.",
    expected_effect: "commits",
    correlation: "none",
  });
  const steps: Step[] = [
    ...SIGN_IN_STEPS.slice(0, 3),
    { name: "click", input: { element: "e2", ...why } },
    { name: "click", input: { element: "e1", ...why } },
    { name: "done", input: { summary: "Posted.", proof: ["e1"] } },
  ];

  /** Runs the transfer, aborting during the settle wait that follows the Submit click. */
  async function submitThenAbort(): Promise<{ r: Ran; sent: string[] }> {
    const sent: string[] = [];
    const ctl = new AbortController();
    const hub = new AbortingHub(ctl.signal);
    const { factory } = spying(SITE, {
      // Why: no events ever arrive, so the settle after each click waits on the clock.
      events: hub,
      onAct: (a, lease, inner) => {
        hub.arm();
        sent.push(a.type);
        return inner.act(a, lease);
      },
    });
    const r = await aborted(
      ctl,
      {
        spec: TRANSFER,
        steps,
        surface: factory,
        answers: [{ staff: "op_017", decision: "approve_irreversible" }],
      },
      // Five actions sent (type, type, three clicks): the last click is the Submit.
      () => sent.length >= 5,
    );
    return { r, sent };
  }

  test("the action line says dispatched, run.json and run_end count it, nothing more is sent", async () => {
    const { r, sent } = await submitThenAbort();
    expectEndedByOperator(r);
    expect(sent).toHaveLength(5);
    const actions = r.events.filter((e) => e.event === "action");
    expect(actions).toHaveLength(5);
    expect(actions.at(-1)).toMatchObject({ data: { type: "click", dispatched: true } });
    expect(runJson(r).counts).toMatchObject({ actions: 5 });
    expect(r.events.at(-1)).toMatchObject({ data: { counts: { actions: 5, commits: 1 } } });
    expect(r.operator.requests).toHaveLength(1);
    // The planner's "done" was never reached: the next turn saw the abort first.
    expect(names(r.events).filter((e) => e === "llm_decision")).toHaveLength(5);
  });

  test("the crash sweep finds nothing to mark internal_error afterwards", async () => {
    const { r } = await submitThenAbort();
    const evidence = new FileEvidenceStore({
      root: join(r.root, "evidence"),
      tmpDir: join(r.root, "tmp"),
    });
    const deps = { ...(await harness()), evidence };
    // Not vacuous: the tenant index names this run, with its final status.
    const index = await evidence.index("keystone");
    if (!index.ok) throw new Error("the tenant index is unreadable");
    expect(index.value.filter((row) => (row as { run_id: string }).run_id === r.result.runId).at(-1)).toMatchObject({
      status: "failed",
      code: "ended_by_operator",
    });
    expect(await runSweep(deps, "keystone")).toMatchObject({ closed: 0, manual: 0 });
    expect(runJson(r)).toMatchObject({ status: "failed", code: "ended_by_operator" });
  });
});

describe("Ctrl-C during the session prelude (section 6 §5.5, §10.4)", () => {
  /** A planner that must never be asked: the prelude ends the run first. */
  const planner = (): ScriptedPlanner =>
    new ScriptedPlanner([{ name: "done", input: { summary: "On the home page.", proof: ["e1"] } }]);

  test("an abort while the prelude's click settles ends the run ended_by_operator; no planner call", async () => {
    const p = planner();
    const sent: string[] = [];
    const ctl = new AbortController();
    const hub = new AbortingHub(ctl.signal);
    const { factory } = spying(SITE, {
      events: hub,
      onAct: (a, lease, inner) => {
        sent.push(a.type);
        return inner.act(a, lease);
      },
    });
    const r = await aborted(
      ctl,
      { spec: LINKED_SPEC, sealedSession: SESSION_ARTIFACT, planner: p, surface: factory },
      () => sent.length >= 1,
    );
    expectEndedByOperator(r);
    expect(p.seen).toHaveLength(0);
  });

  test("a prelude throw that is not an abort still propagates", async () => {
    const { factory } = spying(SITE, {
      onAct: () => {
        throw new Error("surface bug");
      },
    });
    await expect(
      run({
        spec: LINKED_SPEC,
        sealedSession: SESSION_ARTIFACT,
        planner: planner(),
        surface: factory,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("surface bug");
  });
});
