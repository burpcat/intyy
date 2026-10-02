// Proves C3: accepting a native confirm or alert box is classed by the box's MESSAGE words only.
// The Accept button's own "OK" never counts. No list word in the message is unsure, so
// irreversible; Accept with no open box reads an empty message, so it is unsure; Dismiss is
// unchanged. The gate result and the gate line carry the same masked label and path.
// Design section 4 §7.5 (C3), §7.6, §7.7; section 7 §9.1. From the owner's real run, 2026-09-30.
import { describe, expect, test } from "vitest";
import {
  classify,
  type ClickInput,
  type RiskWords,
} from "../../../src/core/safety/risk/classify.js";
import type { GateAction, GateRun, Proposal } from "../../../src/core/safety/gate/gate.js";
import type { Actor } from "../../../src/core/safety/rules.js";
import { snapshotFactory, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import type { NativeDialog } from "../../../src/ports/surface.js";
import {
  DISCOVERY,
  LEASE,
  gateConfig,
  openTestGate,
  testPolicy,
  type Opened,
} from "../../contract/surface/gate-kit.js";

/** The global default lists, as the approved global policy holds them (section 4 §7.3). */
const words: RiskWords = {
  irreversible_words: ["confirm", "delete", "transfer", "open account", "close account"],
  reversible_words: ["add", "append"],
  safe_words: ["search", "show", "details", "view", "open", "close", "help"],
  key_labels: {},
};

/** A click on Accept (or any button) with this label and message. */
function click(label: string, dialogMessage: string | null): ClickInput {
  return {
    type: "click",
    control: { role: "button", roleGroup: "button_like", words: [label] },
    link: null,
    pageIrreversible: false,
    submitsMoneyForm: false,
    dialogMessage,
  };
}

const IRREVERSIBLE_UNSURE = { risk: "irreversible", unsure: true, reason: "unsure" };

describe("C3 in the classifier: only the message words count", () => {
  test("classify reads the message words only: unsure without a list word, by word with one, safe words ignored", () => {
    const safeOk: RiskWords = { ...words, safe_words: [...words.safe_words, "ok"] };
    expect(classify(click("OK", "Are you sure you want to go on?"), safeOk)).toEqual(
      IRREVERSIBLE_UNSURE,
    );
    const real = testPolicy({ allow: ["/"], deny: [], irreversible: [] }).risk;
    expect(
      classify(click("OK", "Are you sure you want to open this sub-account?"), real),
    ).toEqual(IRREVERSIBLE_UNSURE);
    expect(classify(click("OK", "Delete member?"), words)).toEqual({
      risk: "irreversible",
      unsure: false,
      reason: "irreversible_word",
    });
    expect(classify(click("OK", "Add a note to this member?"), words)).toEqual({
      risk: "reversible",
      unsure: false,
      reason: "reversible_word",
    });
    expect(classify(click("OK", "Show the details?"), words)).toEqual(IRREVERSIBLE_UNSURE);
    expect(classify(click("Open member detail", null), words)).toEqual({
      risk: "idempotent",
      unsure: false,
      reason: "safe_word",
    });
    expect(classify(click("OK", ""), words)).toEqual(IRREVERSIBLE_UNSURE);
    expect(classify(click("Show", "Are you sure you want to go on?"), words)).toEqual(
      IRREVERSIBLE_UNSURE,
    );
    expect(classify(click("Cancel", null), words)).toEqual(IRREVERSIBLE_UNSURE);
    expect(classify(click("Close", null), words).risk).toBe("idempotent");
  });

  // Why: this is the message from the owner's real run (2026-09-30), on the real global lists,
  // where "open" is a safe word. The owner's brief expects unsure, so a human must approve it.
  // Why: owner decision 2026-09-30, a safe word in a box's message proves nothing about OK.
});

const ORIGIN = "http://127.0.0.1:9182";

const policy = testPolicy({ allow: ["/"], deny: ["/__test__/*"], irreversible: [] });

/** The message a box shows, by opener button. Openers are safe ("Show"), so they always pass. */
const BOXES: Record<string, NativeDialog> = {
  "Show A": { kind: "confirm", message: "Are you sure you want to go on?" },
  "Show B": { kind: "confirm", message: "Delete member?" },
  "Show C": { kind: "confirm", message: "Add a note to this member?" },
  "Show D": { kind: "confirm", message: "Show the details?" },
  "Show E": { kind: "alert", message: "Your session will end soon." },
  "Show F": { kind: "alert", message: "Delete member now." },
};

const site: FakeSite = {
  origin: ORIGIN,
  screens: {
    "/": {
      elements: Object.entries(BOXES).map(([name, dialog], i) => ({
        id: `open${String(i)}`,
        role: "button",
        roleGroup: "button_like" as const,
        name,
        text: name,
        onClick: { dialog },
      })),
    },
  },
};

const REPLAY: GateRun = { ...DISCOVERY, kind: "replay", declaredPaths: ["/"] };

/** Opens a gate, and shows the box behind `opener`. Returns the gate and the Accept ref. */
async function withBox(opener: string, run: GateRun = DISCOVERY, actor: Actor = "llm") {
  const g = await openTestGate(snapshotFactory(site), gateConfig(ORIGIN, policy), policy, run);
  const o1 = await g.eyes.observe();
  const button = o1.ok ? o1.value.elements.find((e) => e.clues.name === opener) : undefined;
  if (button === undefined) throw new Error(`no ${opener}`);
  const opened = await g.gate.act(propose(actor, { type: "click", target: button.ref }));
  if (!opened.ok || opened.value.decision !== "allowed") throw new Error("the opener did not pass");
  const o2 = await g.eyes.observe();
  const find = (name: string) => {
    const el = o2.ok ? o2.value.elements.find((e) => e.clues.name === name) : undefined;
    if (el === undefined) throw new Error(`no ${name} on the box`);
    return el.ref;
  };
  return { g, accept: find("OK"), find, o: o2.ok ? o2.value : null };
}

const propose = (actor: Actor, action: GateAction, extra: Partial<Proposal> = {}): Proposal => ({
  actor,
  lease: LEASE,
  action,
  step: null,
  ...extra,
});

/** Proposes Accept as the LLM, with no human yes, and returns "decision rule". */
async function accept(g: Opened, target: Proposal["action"], actor: Actor = "llm") {
  const r = await g.gate.act(propose(actor, target));
  if (!r.ok) throw new Error(`act failed: ${r.failure}`);
  return r.value;
}

describe("C3 in the gate: accepting a box on the snapshot fake", () => {
  const cases: [opener: string, rule: string, risk: string][] = [
    ["Show A", "risk.unsure", "irreversible"],
    ["Show B", "risk.needs_approval", "irreversible"],
    ["Show C", "risk.allowed", "reversible"],
    ["Show D", "risk.unsure", "irreversible"],
    ["Show E", "risk.unsure", "irreversible"],
    ["Show F", "risk.needs_approval", "irreversible"],
  ];
  test("accepting each box gets its rule, risk, decision, and a masked log line", async () => {
    for (const [opener, rule, risk] of cases) {
      const message = BOXES[opener]?.message ?? "";
      const tag = `${BOXES[opener]?.kind ?? ""} "${message}": ${rule}`;
      const { g, accept: target } = await withBox(opener);
      try {
        const r = await accept(g, { type: "click", target });
        expect(r.rule, tag).toBe(rule);
        expect(r.risk, tag).toBe(risk);
        expect(r.decision, tag).toBe(rule === "risk.allowed" ? "allowed" : "needs_approval");
        // Why: the log label stays the masked Accept button name, never the message.
        expect(g.lines.at(-1), tag).toMatchObject({
          why: { ref: rule },
          data: { action: "click", label: "OK", path: "/", risk },
        });
      } finally {
        await g.gate.close();
      }
    }
  });

  test("a human yes lets the unsure box be accepted, and it reports dispatched", async () => {
    const { g, accept: target } = await withBox("Show A");
    const r = await g.gate.act(
      propose("llm", { type: "click", target }, { approval: { by: "op_022" } }),
    );
    expect(r.ok && [r.value.rule, r.value.act?.dispatched]).toEqual(["risk.human_approved", true]);
    await g.gate.close();
  });

  test("Dismiss on a safe-word-message box is unchanged: Cancel is a bland label, so unsure", async () => {
    const { g, find } = await withBox("Show D");
    const r = await accept(g, { type: "click", target: find("Cancel") });
    expect([r.decision, r.rule, r.risk]).toEqual(["needs_approval", "risk.unsure", "irreversible"]);
    await g.gate.close();
  });
});

describe("C3 in a replay run follows the same rule", () => {
  test("engine: an unsure message needs a human; a delete message needs approval", async () => {
    const a = await withBox("Show A", REPLAY, "engine");
    expect(await accept(a.g, { type: "click", target: a.accept }, "engine")).toMatchObject({
      decision: "needs_approval",
      rule: "risk.unsure",
    });
    await a.g.gate.close();
    const b = await withBox("Show B", REPLAY, "engine");
    expect(await accept(b.g, { type: "click", target: b.accept }, "engine")).toMatchObject({
      decision: "needs_approval",
      rule: "risk.needs_approval",
    });
    await b.g.gate.close();
  });

  test("engine: a safe-word message is ignored, so it is unsure and needs a human", async () => {
    const d = await withBox("Show D", REPLAY, "engine");
    expect(await accept(d.g, { type: "click", target: d.accept }, "engine")).toMatchObject({
      decision: "needs_approval",
      rule: "risk.unsure",
      risk: "irreversible",
    });
    await d.g.gate.close();
  });
});

describe("the gate result carries the gate line's label and path", () => {
  test("a needs_approval result holds the same masked label and path as its log line", async () => {
    const { g, accept: target } = await withBox("Show A");
    const r = await accept(g, { type: "click", target });
    const line = g.lines.at(-1);
    expect(r.label).toBe("OK");
    expect(r.path).toBe("/");
    expect(r.label).toBe(line?.data.label);
    expect(r.path).toBe(line?.data.path);
    await g.gate.close();
  });

  test("a click with no named target has no label", async () => {
    const g = await openTestGate(snapshotFactory(site), gateConfig(ORIGIN, policy), policy);
    const r = await accept(g, { type: "scroll", direction: "down" });
    expect(r.label).toBeUndefined();
    await g.gate.close();
  });
});
