// Proves the approval request shows what the GATE classified for this action, not what the
// model named: the label, action, rule, and path come from the gate; `detail` says so when the
// model named another element. The mailbox keeps the new fields, and an old request still parses.
// Design section 4 §7.7 (a human approves what the gate saw); section 9 §10.5. From the owner's
// real run, 2026-09-30, where the model named "Search" and the gate classed a footer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MailboxOperator } from "../../../src/adapters/mailbox/mailbox.js";
import { OperatorSupervisor } from "../../../src/core/discovery/supervisor.js";
import { Intervention } from "../../../src/core/model/mailbox.js";
import { RunSpec } from "../../../src/core/model/runspec.js";
import { masked } from "../../../src/core/safety/redaction/compose.js";
import { ManualClock } from "../../../src/fakes/clock.js";
import { ScriptedPlanner, type Step } from "../../../src/fakes/scripted-planner.js";
import { snapshotFactory } from "../../../src/fakes/snapshot-surface/index.js";
import { fromFactory, toFactory } from "../../../src/ports/hands.js";
import { ok } from "../../../src/ports/outcome.js";
import type { Eyes, SurfaceFactory } from "../../../src/ports/surface.js";
import { tempRoot } from "../safety/canary-kit.js";
import { redactor } from "./kit.js";
import { SIGN_IN, SIGN_IN_STEPS, SITE, run, type Ran } from "./run-kit.js";

const done: Ran[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const r of done.splice(0)) await r.remove();
  for (const c of cleanups.splice(0)) await c();
});

const TRANSFER = RunSpec.parse({
  ...SIGN_IN,
  capability: "transfer",
  goal: "Sign in, then open the transfers.",
  expected_effect: "commits",
  correlation: "none",
});

/** The approval block of the request at `i`, read back through the real schema. */
function approvalOf(r: Ran, i = 0) {
  return Intervention.parse(r.operator.requests[i]).approval;
}

const why = { reason: "Look around.", expected: "Something changes.", tag: "flow_step" };

/**
 * The snapshot fake, except that once `flag.on` is set the link the model sees as "Transfers"
 * reads "Submit Transfer" to the gate. The same ref then names another control, as in the real run.
 */
function swapping(flag: { on: boolean }): SurfaceFactory {
  const inner = fromFactory(snapshotFactory(SITE));
  return toFactory({
    close: () => inner.close(),
    open: async (cfg, signal) => {
      const opened = await inner.open(cfg, signal);
      if (!opened.ok) return opened;
      const real = opened.value.eyes;
      const eyes: Eyes = {
        observe: async (s) => {
          const o = await real.observe(s);
          if (!o.ok || !flag.on) return o;
          const elements = o.value.elements.map((e) =>
            e.clues.name === "Transfers" ? { ...e, clues: { ...e.clues, name: "Submit Transfer" } } : e,
          );
          return ok({ ...o.value, elements });
        },
        screenshot: (m, s) => real.screenshot(m, s),
        snapshots: (s) => real.snapshots(s),
        crop: (e, s) => real.crop(e, s),
        events: (s) => real.events(s),
      };
      return ok({ eyes, hands: opened.value.hands });
    },
  });
}

/** Sign in, then click the "Transfers" link (e2). `onClick` runs as the model answers. */
const steps = (onClick: () => void): Step[] => [
  ...SIGN_IN_STEPS.slice(0, 3),
  () => {
    onClick();
    return { name: "click", input: { element: "e2", ...why } };
  },
];

describe("the approval request carries the gate's own facts", () => {
  test("the model names A, the gate classes B: label, action, rule, path, and detail say B", async () => {
    const flag = { on: false };
    const r = await run({
      spec: TRANSFER,
      planner: new ScriptedPlanner(
        steps(() => {
          flag.on = true;
        }),
      ),
      surface: swapping(flag),
      answers: [{ staff: "op_017", decision: "decline" }],
    });
    done.push(r);
    const ask = r.operator.requests[0];
    expect(ask).toMatchObject({ kind: "approval", reason: "discovery_irreversible" });
    const approval = approvalOf(r);
    expect(approval).toMatchObject({
      words: "Submit Transfer",
      risk: "irreversible",
      action: "click",
      rule: "risk.needs_approval",
      path: "/home",
    });
    const detail = approval?.detail;
    expect(detail).toContain("Submit Transfer");
    expect(detail).toContain("Transfers");

    // Why: the ask, the escalation line, and the gate line say the same label for B.
    const gate = r.events.filter((e) => e.event === "gate").at(-1) as {
      data: { decision: string; label: string; path: string };
    };
    expect(gate.data).toMatchObject({ decision: "needs_approval", label: "Submit Transfer" });
    expect(approval?.words).toBe(gate.data.label);
    expect(approval?.path).toBe(gate.data.path);
    const esc = r.events.find((e) => e.event === "escalation") as {
      data: { label: string; detail?: string };
    };
    expect(esc.data.label).toBe(gate.data.label);
    expect(esc.data.detail).toBe(detail);
  });

  test("the model names the element the gate classed: detail is null", async () => {
    const r = await run({
      spec: TRANSFER,
      planner: new ScriptedPlanner([
        ...SIGN_IN_STEPS.slice(0, 3),
        { name: "click", input: { element: "e2", ...why } },
        { name: "click", input: { element: "e1", ...why } },
      ]),
      answers: [{ staff: "op_017", decision: "decline" }],
    });
    done.push(r);
    expect(approvalOf(r)).toMatchObject({
      words: "Submit Transfer",
      action: "click",
      rule: "risk.needs_approval",
      path: "/transfer",
      detail: null,
    });
    const esc = r.events.find((e) => e.event === "escalation") as { data: object };
    expect(esc.data).not.toHaveProperty("detail");
  });
});

describe("the mailbox approval fields", () => {
  const RUN_ID = "run_2026-09-28_7kq2m9x4tb";

  test("action, rule, path, and detail round-trip through request.json", async () => {
    const { root, remove } = await tempRoot("intyy-appr-");
    cleanups.push(remove);
    const dirs = { evidenceRoot: join(root, "evidence"), tmpDir: join(root, "tmp") };
    const port = new MailboxOperator(dirs, { tenant: "keystone", runId: RUN_ID }, 5);
    const sup = new OperatorSupervisor(port, new ManualClock("2026-09-28T14:00:00.000Z"), redactor(), {
      runId: RUN_ID,
      tenant: "keystone",
      capability: "kvfcu/transfer",
      deadlineMinutes: 30,
    });
    void sup.approve({
      turn: 7,
      element: "e4",
      label: masked`Submit Transfer`,
      action: "click",
      rule: "risk.unsure",
      path: masked`/home`,
      detail: masked`The gate classified "Submit Transfer", but the model named "Search".`,
      screenshot: null,
    });
    const file = join(dirs.evidenceRoot, "keystone", "runs", RUN_ID, "mailbox", "01_approval", "request.json");
    for (let i = 0; i < 400; i += 1) {
      try {
        readFileSync(file);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    const req = Intervention.parse(JSON.parse(readFileSync(file, "utf8")));
    expect(req.approval).toEqual({
      words: "Submit Transfer",
      risk: "irreversible",
      authorization: "none",
      action: "click",
      rule: "risk.unsure",
      path: "/home",
      detail: 'The gate classified "Submit Transfer", but the model named "Search".',
    });
  });

  test("a request from before these fields still parses", () => {
    const old = {
      schema: "intyy.intervention/1.0",
      run_id: RUN_ID,
      tenant: "keystone",
      capability: "kvfcu/transfer",
      kind: "approval",
      reason: "discovery_irreversible",
      step: { id: "t7", intent: null },
      trouble: null,
      ladder: [],
      commit: { state: "none" },
      operator_note: null,
      approval: { words: "Submit Transfer", risk: "irreversible", authorization: "none" },
      screenshot: null,
      decisions: ["approve_irreversible", "decline"],
      outcomes: [],
      deadline: "2026-09-28T14:30:00.000Z",
      lease: null,
      on_handback: null,
      opened_at: "2026-09-28T14:00:00.000Z",
    };
    const parsed = Intervention.parse(old);
    expect(parsed.approval).toEqual(old.approval);
  });

  test("an unknown approval field is still refused", () => {
    const bad = {
      schema: "intyy.intervention/1.0",
      run_id: RUN_ID,
      tenant: "keystone",
      capability: "kvfcu/transfer",
      kind: "approval",
      reason: "discovery_irreversible",
      step: { id: "t7", intent: null },
      trouble: null,
      ladder: [],
      commit: { state: "none" },
      operator_note: null,
      approval: { words: "x", risk: "irreversible", authorization: "none", extra: 1 },
      screenshot: null,
      decisions: ["decline"],
      outcomes: [],
      deadline: null,
      lease: null,
      on_handback: null,
      opened_at: "2026-09-28T14:00:00.000Z",
    };
    expect(Intervention.safeParse(bad).success).toBe(false);
  });
});
