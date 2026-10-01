// Proves takeover during discovery (section 6 §10.5): a stuck model opens a claimable takeover; the
// operator claims it, acts in the browser, and releases; the bot gets the lease back with a new
// token and the model sees the new screen plus one history line; human actions are logged with no
// tag, and typed text never reaches a file; "end run" and a timeout end the run; a person who
// touches the browser while the bot drives, even while an approval waits, opens a takeover; and
// the recorder reads the human actions as untagged, blocking until a reviewer tags them.
// Design section 6 §10.5, §14; section 7 §12 to §14; section 4 §8.10; docs/decisions.md, M07 task 7.
import { afterAll, describe, expect, test } from "vitest";
import { RunSpec } from "../../../src/core/model/runspec.js";
import { collectActions } from "../../../src/core/recorder/collect.js";
import { parseLine } from "../../../src/core/recorder/log-lines.js";
import { record } from "../../../src/core/recorder/record.js";
import { ScriptedPlanner, type Step } from "../../../src/fakes/scripted-planner.js";
import { SnapshotSurface } from "../../../src/fakes/snapshot-surface/index.js";
import { toFactory } from "../../../src/ports/hands.js";
import type { LeaseToken } from "../../../src/ports/surface.js";
import { HoldingClock } from "../handoff/kit.js";
import { SIGN_IN, SIGN_IN_STEPS, SITE, run, type Ran } from "./run-kit.js";
import { spying } from "./tap-kit.js";

const STAFF = "op_017";
const CLAIM = { staff: STAFF, claimed: true } as const;
const RELEASE = { staff: STAFF, released: true } as const;
const END = { staff: STAFF, decision: "end_run" } as const;
/** Made up and distinctive: it must appear in no file of the run. */
const RAW = "ZEBRA-4471-quokka";

const finished: Ran[] = [];
afterAll(async () => {
  for (const r of finished.splice(0)) await r.remove();
});
async function go(opts: Parameters<typeof run>[0]): Promise<Ran> {
  const r = await run(opts);
  finished.push(r);
  return r;
}

const STUCK: Step = { name: "stuck", input: { reason: "No sign-in form." } };
const DONE: Step = { name: "done", input: { summary: "Signed in.", proof: ["e1"] } };
const why = { reason: "Go on.", expected: "It opens." };

type Line = { seq: number; event: string; step: string | null; by: string; data: Record<string, unknown> };
const lines = (r: Ran): Line[] => r.events as unknown as Line[];
const leaseReasons = (r: Ran): unknown[] => lines(r).filter((l) => l.event === "lease").map((l) => l.data["reason"]);
const escalations = (r: Ran): Line[] => lines(r).filter((l) => l.event === "escalation");
const humanActions = (r: Ran): Line[] => lines(r).filter((l) => l.event === "action" && l.by === "human");
const seenBy = (r: Ran) => (r.planner as ScriptedPlanner).seen;

/** The operator types in the user box and clicks Sign In: two actions, ending on `/home`. */
const typeAndSignIn = (s: SnapshotSurface): void => {
  s.humanInput({ type: "type", element: "user", value: RAW });
  s.humanInput({ type: "click", element: "go" });
};

/** The handback scenario: the model is stuck, the operator claims, acts twice, and releases. */
async function handback(extra: Partial<Parameters<typeof run>[0]> = {}): Promise<Ran & { surface: SnapshotSurface }> {
  const surface = new SnapshotSurface(SITE);
  const r = await go({
    clock: new HoldingClock("2026-09-28T14:00:00.000Z"),
    surface: toFactory(surface),
    steps: [STUCK, DONE],
    answers: [CLAIM, { act: () => { typeAndSignIn(surface); } }, RELEASE],
    ...extra,
  });
  return Object.assign(r, { surface });
}

describe("claim, act, hand back (section 6 §10.5)", () => {
  test("the run succeeds; the lease moves takeover_requested, claimed, handed_back, reverified", async () => {
    const r = await handback();
    expect(r.result).toMatchObject({ status: "success", code: null });
    expect(leaseReasons(r)).toEqual([
      "run_start",
      "takeover_requested",
      "claimed",
      "handed_back",
      "reverified",
      "run_end",
    ]);
  });

  test("the request is claimable: lease nobody, decisions end_run only", async () => {
    const r = await handback();
    expect(r.operator.requests).toHaveLength(1);
    expect(r.operator.requests[0]).toMatchObject({
      kind: "takeover",
      reason: "stuck",
      lease: "nobody",
      decisions: ["end_run"],
    });
    expect(r.operator.closed[0]).toBe("resolved");
  });

  test("the escalation lines: open, claimed, resolved handed_back", async () => {
    const r = await handback();
    const e = escalations(r).map((l) => l.data);
    expect(e).toMatchObject([
      { kind: "takeover", reason: "stuck", state: "open" },
      { kind: "takeover", reason: "stuck", state: "claimed", staff_id: STAFF, implicit: false },
      { kind: "takeover", reason: "stuck", state: "resolved", decision: "handed_back", staff_id: STAFF },
    ]);
  });

  test("the model's next turn shows the new screen and one history line with the action count", async () => {
    const r = await handback();
    const seen = seenBy(r);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.message).toContain("t1 operator took over: 2 actions");
    expect(seen[1]?.message).toContain('<screen location="/home" title="Teller Workstation">');
    // The first turn saw the sign-in page.
    expect(seen[0]?.message).toContain('<screen location="/" title="Sign In">');
  });

  test("one action reads '1 action'", async () => {
    const surface = new SnapshotSurface(SITE);
    const r = await go({
      clock: new HoldingClock("2026-09-28T14:00:00.000Z"),
      surface: toFactory(surface),
      steps: [STUCK, DONE],
      answers: [CLAIM, { act: () => { surface.humanInput({ type: "click", element: "go" }); } }, RELEASE],
    });
    expect(seenBy(r)[1]?.message).toContain("t1 operator took over: 1 action");
    expect(seenBy(r)[1]?.message).not.toContain("1 actions");
  });

  test("human actions are logged by the human, with no tag; the typed text is [human_text]", async () => {
    const r = await handback();
    const acts = humanActions(r);
    expect(acts.map((l) => l.data["type"])).toEqual(["type", "click"]);
    expect(acts[0]?.data["value"]).toBe("[human_text]");
    for (const a of acts) {
      expect(a.data).not.toHaveProperty("tag");
      expect(a.data).not.toHaveProperty("reason");
      expect(a.data["staff_id"]).toBe(STAFF);
    }
    // Both took place under the turn the takeover opened on.
    expect(acts.every((l) => l.step === "t1")).toBe(true);
  });

  test("after the handback the gate takes a new token: the old one is never used again", async () => {
    const tokens: LeaseToken[] = [];
    const { factory } = spying(SITE, {
      onAct: (a, lease, inner) => {
        tokens.push(lease);
        return inner.act(a, lease);
      },
    });
    const r = await go({
      clock: new HoldingClock("2026-09-28T14:00:00.000Z"),
      surface: factory,
      steps: [SIGN_IN_STEPS[0] as Step, STUCK, SIGN_IN_STEPS[1] as Step, SIGN_IN_STEPS[2] as Step, DONE],
      answers: [CLAIM, RELEASE],
    });
    expect(r.result.status).toBe("success");
    expect(tokens).toHaveLength(3);
    // The bot's first action carried the first grant; the two after the handback carry the new one.
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(tokens[1]).toBe(tokens[2]);
    expect(leaseReasons(r)).toContain("reverified");
  });

  test("the takeover clears the stuck counters: a block before it does not carry over", async () => {
    // Two blocked actions (limit three), a stuck takeover, then another block: still going on.
    const blocked: Step = { name: "navigate", input: { location: "/__test__/reset", ...why, tag: "flow_step" } };
    const surface = new SnapshotSurface(SITE);
    const r = await go({
      clock: new HoldingClock("2026-09-28T14:00:00.000Z"),
      surface: toFactory(surface),
      steps: [blocked, blocked, STUCK, blocked, ...SIGN_IN_STEPS],
      answers: [CLAIM, RELEASE],
    });
    expect(r.result.status).toBe("success");
  });
});

describe("the operator ends it, or nobody answers (section 6 §10.4)", () => {
  test("end_run: failed, ended_by_operator", async () => {
    const r = await go({ clock: new HoldingClock("2026-09-28T14:00:00.000Z"), steps: [STUCK], answers: [END] });
    expect(r.result).toMatchObject({ status: "failed", code: "ended_by_operator" });
    expect(escalations(r).at(-1)?.data).toMatchObject({ state: "resolved", decision: "end_run" });
  });

  test("silent until the deadline: failed, escalation_timeout", async () => {
    // The default stepping clock lets a silent request reach its deadline at once.
    const r = await go({ steps: [STUCK], answers: ["silent"] });
    expect(r.result).toMatchObject({ status: "failed", code: "escalation_timeout" });
    expect(escalations(r).at(-1)?.data).toMatchObject({ state: "timed_out" });
  });

  test("a claim that never ends in a release still ends by the operator's end_run", async () => {
    const r = await go({ clock: new HoldingClock("2026-09-28T14:00:00.000Z"), steps: [STUCK], answers: [CLAIM, END] });
    expect(r.result).toMatchObject({ status: "failed", code: "ended_by_operator" });
    expect(leaseReasons(r)).toEqual(["run_start", "takeover_requested", "claimed", "run_end"]);
  });
});

describe("a person touches the browser while the bot drives (section 7 §12.4)", () => {
  test("a bare input opens an unexpected_human_input takeover; the bot's next action is not dispatched", async () => {
    const surface = new SnapshotSurface(SITE);
    const r = await go({
      clock: new HoldingClock("2026-09-28T14:00:00.000Z"),
      surface: toFactory(surface),
      // The person touches the browser while the model decides; its typing must then never land.
      steps: [
        () => {
          surface.humanInput();
          return { name: "type", input: { element: "e3", value: "{secret.operator_username}", ...why, tag: "flow_step" } };
        },
      ],
      answers: [END],
    });
    const warning = lines(r).find((l) => l.event === "warning" && l.data["code"] === "human_input_while_bot");
    expect(warning).toBeDefined();
    expect(escalations(r)[0]?.data).toMatchObject({ kind: "takeover", reason: "unexpected_human_input", state: "open" });
    expect(r.operator.requests[0]).toMatchObject({ kind: "takeover", reason: "unexpected_human_input", lease: "nobody" });
    // Nothing the bot asked for ran: no bot action line, no gate line for it.
    expect(lines(r).filter((l) => l.event === "action" && l.by === "llm")).toEqual([]);
    expect(lines(r).filter((l) => l.event === "gate" && l.data["actor"] === "llm")).toEqual([]);
    expect(r.result).toMatchObject({ status: "failed", code: "ended_by_operator" });
  });

  test("input during an approval wait closes the request run_ended and opens a takeover", async () => {
    const surface = new SnapshotSurface(SITE);
    const transfer = RunSpec.parse({
      ...SIGN_IN,
      capability: "transfer",
      goal: "Sign in, then submit the transfer.",
      expected_effect: "commits",
      correlation: "none",
    });
    const r = await go({
      clock: new HoldingClock("2026-09-28T14:00:00.000Z"),
      surface: toFactory(surface),
      spec: transfer,
      steps: [
        ...SIGN_IN_STEPS.slice(0, 3),
        { name: "click", input: { element: "e2", ...why, tag: "flow_step" } },
        { name: "click", input: { element: "e1", ...why, tag: "flow_step" } },
        DONE,
      ],
      answers: [
        // The approval waits silently. A moment later (after it is waiting) a person touches the page.
        { act: () => { setTimeout(() => { surface.humanInput(); }, 10); } },
        "silent",
        END,
      ],
    });
    expect(r.operator.requests.map((q) => q.kind)).toEqual(["approval", "takeover"]);
    expect(r.operator.closed[0]).toBe("run_ended");
    expect(r.operator.requests[1]).toMatchObject({ reason: "unexpected_human_input" });
    expect(r.result).toMatchObject({ status: "failed", code: "ended_by_operator" });
    // The commit was never sent.
    expect(lines(r).map((l) => l.event)).not.toContain("commit_intent");
    expect(lines(r).filter((l) => l.event === "action" && l.by === "llm" && l.step === "t5")).toEqual([]);
  });
});

describe("the recorder reads a takeover's human actions (section 6 §10.5, §14)", () => {
  test("collectActions: two human actions, the gate's class, the light fingerprint, no typed value", async () => {
    const r = await handback();
    const acts = collectActions(r.result.runId, r.events).filter((a) => a.byHuman === true);
    expect(acts.map((a) => a.tool)).toEqual(["type", "click"]);
    expect(acts[0]?.value).toBeNull();
    expect(acts.every((a) => a.tag === "exploration")).toBe(true);
    expect(acts.every((a) => a.gateRisk === "idempotent")).toBe(true);
    expect(acts[1]?.fingerprint).toMatchObject({ role: "button", crop: null, crop_dropped: "human_action", within: null });
    // The bot's own sign-in turns are not human actions.
    expect(collectActions(r.result.runId, r.events).filter((a) => a.byHuman !== true)).toEqual([]);
  });

  const context = { tenant: "keystone", appVersion: "9.2", viewport: { width: 1280, height: 800, scale: 1 } };
  const recorded = (r: Ran, tags: Record<number, string> = {}) =>
    record({
      positive: { runId: r.result.runId, spec: SIGN_IN, lines: r.events },
      decisions: Object.entries(tags).map(([seq, value]) => ({
        what: "tag" as const,
        subject: `${r.result.runId}#${seq}`,
        value,
      })) as never,
      context,
    });

  test("record: each human action raises a blocking human_action_untagged until a reviewer tags it", async () => {
    const r = await handback();
    const out = recorded(r);
    const untagged = out.issues.filter((i) => i.code === "human_action_untagged");
    expect(untagged).toHaveLength(2);
    expect(untagged.every((i) => i.level === "blocking")).toBe(true);
    // No step came from them: a person's action is exploration until tagged.
    expect(out.candidate.steps).toEqual([]);
  });

  test("tagged flow_step: a click becomes a step; a type blocks as unsupported_step_action", async () => {
    const r = await handback();
    const [typed, clicked] = humanActions(r);
    if (typed === undefined || clicked === undefined) throw new Error("expected two human actions");
    const out = recorded(r, { [typed.seq]: "flow_step", [clicked.seq]: "flow_step" });
    expect(out.issues.filter((i) => i.code === "human_action_untagged")).toEqual([]);
    expect(out.candidate.steps.map((s) => s.action.type)).toEqual(["click"]);
    const blocking = out.issues.find((i) => i.code === "unsupported_step_action");
    expect(blocking).toMatchObject({ level: "blocking", subject: `${r.result.runId}#${String(typed.seq)}` });
  });
});

describe("the log line parser (section 6 §14)", () => {
  const base = {
    seq: 7,
    at: "2026-09-28T14:00:00.000Z",
    run_id: "run_2026-09-28_k3pdr4ft01",
    step: "t1",
    by: "human",
    event: "action",
  };
  const data = {
    type: "click",
    staff_id: STAFF,
    value: null,
    option: null,
    checked: null,
    key: null,
    result: "ok",
    dispatched: true,
    transport: null,
    fingerprint: null,
  };

  test("an action by a human parses as human_action", () => {
    expect(parseLine({ ...base, data })).toMatchObject({ kind: "human_action", by: "human", data: { type: "click" } });
  });

  test("a human action with a tag or an unknown field is malformed: it throws", () => {
    expect(() => parseLine({ ...base, data: { ...data, tag: "flow_step" } })).toThrow();
    expect(() => parseLine({ ...base, data: { type: "click" } })).toThrow();
  });
});

describe("safety (section 4 §8.10)", () => {
  test("the typed raw value appears in no file of the run folder and in no model message", async () => {
    const r = await handback();
    expect(r.files.length).toBeGreaterThan(3);
    for (const f of r.files) {
      expect(Buffer.from(f.bytes).includes(RAW), `${f.path} holds the typed text`).toBe(false);
    }
    for (const turn of seenBy(r)) expect(JSON.stringify(turn)).not.toContain(RAW);
  });
});
