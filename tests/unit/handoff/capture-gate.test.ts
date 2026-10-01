// Proves `HumanCapture` on a real gate and the snapshot fake: a person's input becomes a `gate`
// line (observed) and an `action` line (by human) with masked values; the bot's own input
// is told apart by its window; and `answerDialog` is a human-actor click through the gate, with
// `commit_intent` first when the box is irreversible. Design section 7 §14.1 to §14.5; section 4
// §7.10 (humans are observed, never blocked), §8.10 (typed text). M07 task 3.
import { describe, expect, test } from "vitest";
import { BotWindows, HumanCapture } from "../../../src/core/handoff/capture.js";
import { Lease } from "../../../src/core/handoff/lease.js";
import type { LogLine } from "../../../src/core/orchestrator/run-log.js";
import { openGate } from "../../../src/core/safety/gate/gate.js";
import { Redactor } from "../../../src/core/safety/redaction/redactor.js";
import { ManualClock } from "../../../src/fakes/clock.js";
import { SeededIds } from "../../../src/fakes/ids.js";
import { SnapshotSurface, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { toFactory } from "../../../src/ports/hands.js";
import type { HumanInput } from "../../../src/ports/surface.js";
import { RULES } from "../discovery/kit.js";
import { gateConfig, testDeps, testPolicy } from "../../contract/surface/gate-kit.js";

const ORIGIN = "http://127.0.0.1:9183";
const policy = testPolicy({ allow: ["/"], deny: ["/__test__/*"], irreversible: [] });
const VIEW = { width: 1280, height: 800 };

const button = (id: string, name: string, extra = {}) => ({ id, role: "button", roleGroup: "button_like" as const, name, text: name, ...extra });
const site: FakeSite = {
  origin: ORIGIN,
  screens: {
    "/": {
      elements: [
        button("show_delete", "Show Delete", { onClick: { dialog: { kind: "confirm", message: "Delete member?" } } }),
        button("show_note", "Show Note", { onClick: { dialog: { kind: "confirm", message: "Add a note to this member?" } } }),
        button("plain", "Plain"),
        { id: "note", role: "textbox", roleGroup: "text_entry" as const, label: "Note", field: { kind: "text" as const, value: "" } },
      ],
    },
  },
};

/** One human capture on a real gate; `trace` lists, in order, every line the run would write. */
async function setup() {
  const trace: string[] = [];
  const lines: LogLine[] = [];
  const surface = new SnapshotSurface(site);
  const policyLines: unknown[] = [];
  const windows = new BotWindows(() => 1_000_000);
  const opened = await openGate(toFactory(surface), gateConfig(ORIGIN, policy), {
    ...testDeps(policy, { kind: "replay", readOnly: false, forceHuman: false, authorizationValid: () => false, declaredPaths: ["/"] }, []),
    log: (l) => {
      trace.push(l.event);
      policyLines.push(l);
    },
    beforeDispatch: () => {
      trace.push("commit_intent");
      return Promise.resolve({ ok: true as const, value: undefined });
    },
    botAction: windows,
  });
  if (!opened.ok) throw new Error("open failed");
  const { eyes, gate } = opened.value;
  const lease = new Lease(new SeededIds(new ManualClock(), 4), () => undefined);
  lease.start();
  lease.requestTakeover();
  lease.claim("op_017");
  const redactor = new Redactor(RULES);
  redactor.addKnown({ ref: "input.member_id", value: "700114", label: "pii", type: "text", kind: "member" });
  const capture = new HumanCapture({
    gate,
    eyes,
    lease,
    redactor,
    windows,
    clock: new ManualClock(),
    viewport: VIEW,
    refs: new Map([["input.member_id", "700114"]]),
    commit: null,
    step: () => "click_confirm",
    log: (l) => {
      trace.push(l.event);
      lines.push(l);
    },
  });
  return { capture, eyes, trace, lines, policyLines, surface, windows };
}

const noteFp = {
  role: "textbox",
  roleGroup: "text_entry" as const,
  clues: { label: "Note", path: "/ > note" },
  box: null,
  fieldKind: "text" as const,
};

const typed = (value: string | null, extra: Partial<HumanInput["action"]> = {}): HumanInput => ({
  at: 5,
  url: `${ORIGIN}/`,
  action: { type: "type", target: noteFp, value, ...extra } as HumanInput["action"],
});

describe("a person's input is logged, masked, and never blocked", () => {
  test("typed text: a gate line observed, then an action line by human, value [human_text]", async () => {
    const { capture, trace, lines, policyLines } = await setup();
    capture.record(typed("TOPSECRET99"));
    expect(trace).toEqual(["gate", "action"]);
    expect(policyLines[0]).toMatchObject({ data: { actor: "human", decision: "observed" }, why: { ref: "human.observed" } });
    expect(lines[0]).toMatchObject({
      event: "action",
      by: "human",
      step: "click_confirm",
      data: { type: "type", staff_id: "op_017", value: "[human_text]", dispatched: true },
    });
    expect(JSON.stringify([lines, policyLines])).not.toContain("TOPSECRET99");
  });

  test("a password field: [secret]; a known input's value: its reference", async () => {
    const { capture, lines } = await setup();
    capture.record(typed(null));
    capture.record(typed("700114"));
    expect(lines.map((l) => (l.data as { value: unknown }).value)).toEqual(["[secret]", "{input.member_id}"]);
  });

  test("a click's fingerprint holds the name only for a button-like control", async () => {
    const { capture, lines } = await setup();
    capture.record({
      at: 5,
      url: `${ORIGIN}/`,
      action: { type: "click", target: { role: "button", roleGroup: "button_like", clues: { name: "Plain", text: "Plain", path: "/ > plain" }, box: null } },
    });
    capture.record(typed("x"));
    const prints = lines.filter((l) => l.event === "action").map((l) => (l.data as { fingerprint: { name: string | null; label: string | null; path: string } }).fingerprint);
    expect(prints[0]).toMatchObject({ name: "Plain", path: "/ > plain" });
    expect(prints[1]).toMatchObject({ name: null, label: null, path: "/ > note" });
  });
});

describe("bot or human (section 7 §14.3)", () => {
  test("isBot follows the bot's windows: start and end+299 are the bot's; end+301 or another path is not", async () => {
    const s = await setup();
    // The gate's real window opens when it acts. Drive one bot click on Plain.
    const seen = await s.eyes.observe();
    if (!seen.ok) throw new Error("observe failed");
    const target = seen.value.elements.find((e) => e.clues.name === "Plain");
    if (target === undefined) throw new Error("no Plain button");
    // A fixed-time windows object makes begin/end both 1_000_000, so the window is [t, t+300].
    s.windows.begin(target.clues.path);
    s.windows.end();
    const click = (at: number, path: string): HumanInput => ({
      at,
      url: `${ORIGIN}/`,
      action: { type: "click", target: { role: "button", roleGroup: "button_like", clues: { path }, box: null } },
    });
    expect(s.capture.isBot(click(1_000_000, target.clues.path))).toBe(true);
    expect(s.capture.isBot(click(1_000_299, target.clues.path))).toBe(true);
    expect(s.capture.isBot(click(1_000_301, target.clues.path))).toBe(false);
    expect(s.capture.isBot(click(999_999, target.clues.path))).toBe(false);
    expect(s.capture.isBot(click(1_000_100, "/ > other"))).toBe(false);
  });
});

describe("answerDialog (section 7 §14.5)", () => {
  /** Opens the box behind `opener` as the person would. */
  async function withBox(opener: string) {
    const s = await setup();
    s.surface.humanInput({ type: "click", element: opener });
    return s;
  }

  test("an irreversible box: commit_intent first, then the human click, the action line, and the warning", async () => {
    const s = await withBox("show_delete");
    s.trace.length = 0;
    expect(await s.capture.answerDialog("op_017", "accept")).toBe(true);
    expect(s.trace).toEqual(["gate", "commit_intent", "action", "warning"]);
    expect(s.lines[1]).toMatchObject({ event: "warning", data: { code: "human_irreversible_action" } });
    expect(s.policyLines[0]).toMatchObject({ data: { actor: "human", action: "click", decision: "observed", risk: "irreversible" } });
    expect(s.lines[0]).toMatchObject({ event: "action", by: "human", data: { type: "click", staff_id: "op_017", dispatched: true } });
    // The box is gone: the click reached the hands.
    const after = await s.eyes.observe();
    expect(after.ok && after.value.dialog).toBeNull();
  });

  test("a reversible box needs no commit_intent", async () => {
    const s = await withBox("show_note");
    s.trace.length = 0;
    expect(await s.capture.answerDialog("op_017", "accept")).toBe(true);
    expect(s.trace).toEqual(["gate", "action"]);
  });

  test("with no box open it returns false, clicks nothing, and warns", async () => {
    const s = await setup();
    expect(await s.capture.answerDialog("op_017", "accept")).toBe(false);
    expect(s.trace).toEqual(["warning"]);
    expect(s.lines[0]).toMatchObject({ event: "warning", data: { code: "dialog_answer_not_applied" } });
  });

  test("the answer must match a button on the box: dismiss on an alert (no Cancel) is false", async () => {
    const s = await setup();
    const alertSite: FakeSite = {
      origin: ORIGIN,
      screens: { "/": { elements: [button("show_alert", "Show Alert", { onClick: { dialog: { kind: "alert", message: "Session ends soon." } } })] } },
    };
    const surface = new SnapshotSurface(alertSite);
    const opened = await openGate(toFactory(surface), gateConfig(ORIGIN, policy), testDeps(policy, { kind: "discovery", readOnly: false, forceHuman: false, authorizationValid: () => false, declaredPaths: null }, []));
    if (!opened.ok) throw new Error("open failed");
    surface.humanInput({ type: "click", element: "show_alert" });
    const capture = new HumanCapture({
      gate: opened.value.gate,
      eyes: opened.value.eyes,
      lease: new Lease(new SeededIds(new ManualClock(), 4), () => undefined),
      redactor: new Redactor(RULES),
      windows: s.windows,
      clock: new ManualClock(),
      viewport: VIEW,
      refs: undefined,
      commit: null,
      step: () => null,
      log: () => undefined,
    });
    expect(await capture.answerDialog("op_017", "dismiss")).toBe(false);
  });
});
