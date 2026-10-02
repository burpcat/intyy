// Proves acting (design section 7 §7, §7.2, §9), on the snapshot fake through the gate: each
// action type acts on the fixture site, the dispatch check (a covered click stays
// `dispatched: false`), native dialogs appear as elements, and a pop-up becomes the active
// window. M05 task 6.
import { describe, expect, test } from "vitest";
import { actStep, type ActContext } from "../../../src/core/replay/act.js";
import type { ContractOutput } from "../../../src/core/model/artifact/contract.js";
import type { StepAction } from "../../../src/core/model/artifact/steps.js";
import type { Target } from "../../../src/core/model/artifact/targets.js";
import { RunLog } from "../../../src/core/orchestrator/run-log.js";
import { redactionRules, Redactor } from "../../../src/core/safety/redaction/redactor.js";
import type { Gate, GateRun } from "../../../src/core/safety/gate/gate.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { snapshotFactory } from "../../../src/fakes/snapshot-surface/index.js";
import { FakeEvidenceStore } from "../../../src/fakes/stores.js";
import type { Eyes, Observation } from "../../../src/ports/surface.js";
import { LEASE, gateConfig, openTestGate, testPolicy } from "../../contract/surface/gate-kit.js";
import { FAKE_ORIGIN, SITE_PATHS, fixtureSite } from "../../contract/surface/site.js";

const policy = testPolicy(SITE_PATHS);

/** A replay run: unattended, unauthorized, and with no declared paths to check here. */
const REPLAY: GateRun = {
  kind: "replay",
  readOnly: false,
  forceHuman: false,
  authorizationValid: () => false,
  declaredPaths: null,
};

/** A target: an ID, a made-up description, and clues. */
function target(id: string, clues: Target["clues"]): Target {
  return { id, description: id, clues };
}

/** A declared output: a name, a made-up description, and its type. */
function output(name: string, type: ContractOutput["type"]): ContractOutput {
  return { name, type, description: name, sensitivity: "pii" };
}

/** Observes, or fails the test. */
async function look(eyes: Eyes): Promise<Observation> {
  const o = await eyes.observe();
  if (!o.ok) throw new Error(`observe failed: ${o.failure}`);
  return o.value;
}

/** One open fixture session, and a fresh `ActContext` for whatever is on screen now. */
class Session {
  private constructor(
    readonly eyes: Eyes,
    readonly gate: Gate,
    private readonly redactor: Redactor,
  ) {}

  static async open(): Promise<Session> {
    const opened = await openTestGate(
      snapshotFactory(fixtureSite(FAKE_ORIGIN)),
      gateConfig(FAKE_ORIGIN, policy),
      policy,
      REPLAY,
    );
    return new Session(opened.eyes, opened.gate, new Redactor(redactionRules(policy)));
  }

  /** A context over one target (or none, for `navigate`/`press`) and the current screen.
   * `extra` overrides any field. */
  async ctx(t: Target | null, extra: Partial<ActContext> = {}): Promise<ActContext> {
    return {
      observation: await look(this.eyes),
      targets: t === null ? new Map() : new Map([[t.id, t]]),
      outputs: new Map(),
      refs: undefined,
      redactor: this.redactor,
      gate: this.gate,
      lease: LEASE,
      stepId: "s",
      ...extra,
    };
  }

  close(): Promise<void> {
    return this.gate.close();
  }
}

describe("actStep (section 7 §7, §7.2, §9)", () => {
  test("click, type, select, and set_checked act through the gate", async () => {
    // click acts through the gate: Search navigates to /members.
    {
      const s = await Session.open();
      const c = await s.ctx(target("search_button", { role: "button", name: "Search" }));
      const action: StepAction = { type: "click", target: "search_button" };
      const r = await actStep(action, c);
      if (r.outcome.kind !== "acted") throw new Error(`expected acted, got ${r.outcome.kind}`);
      expect(r.outcome.gate).toMatchObject({
        ok: true,
        value: { decision: "allowed", act: { dispatched: true } },
      });
      expect((await look(s.eyes)).url).toBe(`${FAKE_ORIGIN}/members`);
      await s.close();
    }

    // type resolves an {input.*} value before the gate ever sees it.
    {
      const s = await Session.open();
      const c = await s.ctx(target("member_id", { role: "textbox", label: "Member ID" }), {
        refs: new Map([["input.member_id", "100107"]]),
      });
      const action: StepAction = { type: "type", target: "member_id", value: "{input.member_id}" };
      const r = await actStep(action, c);
      if (r.outcome.kind !== "acted") throw new Error(`expected acted, got ${r.outcome.kind}`);
      expect(r.outcome.gate).toMatchObject({ ok: true, value: { decision: "allowed" } });
      const o = await look(s.eyes);
      expect(o.elements.find((e) => e.clues.label === "Member ID")?.field?.value).toBe("100107");
      await s.close();
    }

    // select acts through the gate: Kind becomes Checking.
    {
      const s = await Session.open();
      const c = await s.ctx(target("kind", { role: "combobox", label: "Kind" }));
      const r = await actStep({ type: "select", target: "kind", value: "Checking" }, c);
      if (r.outcome.kind !== "acted") throw new Error(`expected acted, got ${r.outcome.kind}`);
      expect(r.outcome.gate).toMatchObject({ ok: true, value: { decision: "allowed" } });
      const o = await look(s.eyes);
      expect(o.elements.find((e) => e.clues.label === "Kind")?.field?.value).toBe("Checking");
      await s.close();
    }

    // set_checked acts through the gate: Joint becomes checked.
    {
      const s = await Session.open();
      const c = await s.ctx(target("joint", { role: "checkbox", label: "Joint" }));
      const r = await actStep({ type: "set_checked", target: "joint", checked: true }, c);
      if (r.outcome.kind !== "acted") throw new Error(`expected acted, got ${r.outcome.kind}`);
      expect(r.outcome.gate).toMatchObject({ ok: true, value: { decision: "allowed" } });
      const o = await look(s.eyes);
      expect(o.elements.find((e) => e.clues.label === "Joint")?.field?.checked).toBe(true);
      await s.close();
    }
  });

  test("navigate and press need no target: facts stay null", async () => {
    const s = await Session.open();
    const c = await s.ctx(null);
    const nav = await actStep({ type: "navigate", location: "/members" }, c);
    expect(nav.facts).toBeNull();
    if (nav.outcome.kind !== "acted") throw new Error(`expected acted, got ${nav.outcome.kind}`);
    expect(nav.outcome.gate).toMatchObject({ ok: true, value: { act: { dispatched: true } } });
    expect((await look(s.eyes)).url).toBe(`${FAKE_ORIGIN}/members`);

    // Why approval: with no target, the risk classifier has no known submit to clear (§7.9),
    // so a bare `press` needs a human yes; the point here is only that `facts` stays null.
    const pressCtx = await s.ctx(null, { approval: { by: "op_022" } });
    const press = await actStep({ type: "press", key: "Enter" }, pressCtx);
    expect(press.facts).toBeNull();
    if (press.outcome.kind !== "acted") throw new Error(`expected acted, got ${press.outcome.kind}`);
    expect(press.outcome.gate).toMatchObject({ ok: true, value: { act: { dispatched: true } } });
    await s.close();
  });

  test("read returns the raw output for the result, masked for the log, and never from a secret field", async () => {
    const s = await Session.open();
    // Type a value with no known-value binding of its own, then read it back through
    // `read.source: "value"`. The read is what first makes it a known value (section 3 §6.4).
    const memberId = target("member_id", { role: "textbox", label: "Member ID" });
    const typeCtx = await s.ctx(memberId, { refs: new Map([["input.member_id", "100107"]]) });
    await actStep({ type: "type", target: "member_id", value: "{input.member_id}" }, typeCtx);
    const readCtx = await s.ctx(memberId, {
      outputs: new Map([["out_id", output("out_id", "string")]]),
    });
    const read = await actStep(
      { type: "read", target: "member_id", source: "value", output: "out_id" },
      readCtx,
    );
    // Why: the raw value is what a `success` result must show on the terminal (build plan §9).
    expect(read.outcome).toEqual({ kind: "read", raw: "100107", masked: "{output.out_id}" });

    // A later log line holding the same raw text is masked too: the read made it a known value.
    const store = new FakeEvidenceStore();
    const created = await store.createRun("kvfcu", "run_2026-01-15_0000000000");
    if (!created.ok) throw new Error("createRun failed");
    const log = new RunLog(created.value, readCtx.redactor, new SteppingClock());
    await log.append({
      event: "warning",
      step: "s",
      by: "engine",
      data: { note: "account 100107 opened" },
    });
    const events = await store.events("kvfcu", created.value.runId);
    if (!events.ok) throw new Error("events failed");
    const bytes = JSON.stringify(events.value);
    expect(bytes).not.toContain("100107");
    expect(bytes).toContain("{output.out_id}");

    // Read the Members link's visible text, through `read.source: "text"`.
    const members = target("members_link", { role: "link", name: "Members" });
    const textRead = await actStep(
      { type: "read", target: "members_link", source: "text", output: "out_text" },
      await s.ctx(members, { outputs: new Map([["out_text", output("out_text", "string")]]) }),
    );
    expect(textRead.outcome).toEqual({ kind: "read", raw: "Members", masked: "{output.out_text}" });
    await s.close();
  });

  test("target_not_found and target_ambiguous never reach the gate", async () => {
    const s = await Session.open();
    const missing = await actStep(
      { type: "click", target: "gone" },
      await s.ctx(target("gone", { role: "button", name: "Nothing here" })),
    );
    expect(missing.outcome).toMatchObject({ kind: "target_not_found" });
    await s.close();
  });

  test("the dispatch check: a covered click stays not sent, and never acts", async () => {
    const s = await Session.open();
    // Why approval: a bland button-like label is unsure risk (section 4 §7.3); approving it
    // reaches the actual click, which is the readiness check this test proves.
    const c = await s.ctx(target("covered_button", { role: "button", name: "Covered" }), {
      approval: { by: "op_022" },
    });
    const r = await actStep({ type: "click", target: "covered_button" }, c);
    if (r.outcome.kind !== "acted") throw new Error(`expected acted, got ${r.outcome.kind}`);
    expect(r.outcome.gate).toMatchObject({
      ok: true,
      value: { decision: "allowed", act: { dispatched: false } },
    });
    await s.close();
  });

  test("a native dialog appears as elements; Accept is classed by its own words", async () => {
    const s = await Session.open();
    const deleteButton = target("delete_button", { role: "button", name: "Delete" });
    const first = await actStep(
      { type: "click", target: "delete_button" },
      await s.ctx(deleteButton),
    );
    if (first.outcome.kind !== "acted") throw new Error("expected acted");
    expect(first.outcome.gate).toMatchObject({ ok: true, value: { decision: "needs_approval" } });

    const approved = await actStep(
      { type: "click", target: "delete_button" },
      await s.ctx(deleteButton, { approval: { by: "op_022" } }),
    );
    if (approved.outcome.kind !== "acted") throw new Error("expected acted");
    expect(approved.outcome.gate).toMatchObject({ ok: true, value: { decision: "allowed" } });
    const withDialog = await look(s.eyes);
    expect(withDialog.dialog).toEqual({ kind: "confirm", message: "Delete member?" });
    // Why only its elements: section 7 §9.1, while a box is open only its elements are candidates.
    expect(withDialog.elements.map((e) => e.clues.name)).toEqual(["Delete member?", "OK", "Cancel"]);

    // findTarget locates Accept inside the dialog by its own role and words (section 4 §7.5 C3
    // reads the dialog message too), with no dialog-specific code in act.ts. This run's one
    // commit is already spent on the click that opened the dialog, so answering it is a second
    // irreversible action in the same run: correctly blocked (section 4 §7.8 check 3), not
    // silently allowed.
    const accept = target("accept", { role: "button", name: "OK" });
    const acceptResult = await actStep(
      { type: "click", target: "accept" },
      await s.ctx(accept, { approval: { by: "op_022" } }),
    );
    if (acceptResult.outcome.kind !== "acted") throw new Error("expected acted");
    expect(acceptResult.outcome.gate).toMatchObject({
      ok: true,
      value: { decision: "blocked", rule: "risk.second_commit", risk: "irreversible" },
    });
    await s.close();
  });

  test("a pop-up becomes the active window; acting on it needs no extra code", async () => {
    const s = await Session.open();
    const lookup = target("lookup_button", { role: "button", name: "Lookup" });
    const opened = await actStep({ type: "click", target: "lookup_button" }, await s.ctx(lookup));
    if (opened.outcome.kind !== "acted") throw new Error("expected acted");
    expect(opened.outcome.gate).toMatchObject({ ok: true, value: { act: { dispatched: true } } });

    const popup = await look(s.eyes);
    expect(popup.page).toBe("popup");
    expect(popup.url).toBe(`${FAKE_ORIGIN}/lookup`);

    const close = target("close_button", { role: "button", name: "Close" });
    const closed = await actStep(
      { type: "click", target: "close_button" },
      await s.ctx(close, { observation: popup }),
    );
    if (closed.outcome.kind !== "acted") throw new Error("expected acted");
    expect(closed.outcome.gate).toMatchObject({ ok: true, value: { act: { dispatched: true } } });
    expect((await look(s.eyes)).page).toBe("main");
    await s.close();
  });
});
