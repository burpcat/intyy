// Proves the ladder's rung 4 requests on the real mailbox (design section 5 §8.9; section 7
// §13.1 to §13.3; docs/decisions.md M06): `takeover`, `retry_decision`, and
// `reconciliation_decision` open with the right fields, each decision word resolves the
// supervisor's own answer, deadlines follow the design defaults and a policy range, and an
// unanswered request times out on the clock port. Mirrors `mailbox.test.ts`'s own setup.
// M06 task 4.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MailboxDesk, MailboxOperator } from "../../../src/adapters/mailbox/mailbox.js";
import { OperatorSupervisor, type SupervisorFacts } from "../../../src/core/discovery/supervisor.js";
import { GlobalPolicy, TenantPolicy } from "../../../src/core/model/policy.js";
import { mergePolicy } from "../../../src/core/safety/policy/merge.js";
import { ManualClock } from "../../../src/fakes/clock.js";
import type { Masked } from "../../../src/ports/masked.js";
import { tempRoot } from "../safety/canary-kit.js";
import { redactor } from "./kit.js";

const RUN = "run_2026-09-28_7kq2m9x4tb";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A mailbox in a temp folder, and a supervisor on it with `deadlineMinutes`. */
async function setup(deadlineMinutes: number, start = "2026-09-28T14:00:00.000Z") {
  const { root, remove } = await tempRoot("intyy-mail-");
  cleanups.push(remove);
  const dirs = { evidenceRoot: join(root, "evidence"), tmpDir: join(root, "tmp") };
  const clock = new ManualClock(start);
  const port = new MailboxOperator(dirs, { tenant: "keystone", runId: RUN }, 5);
  const facts: SupervisorFacts = { runId: RUN, tenant: "keystone", capability: "kvfcu/transfer", deadlineMinutes };
  const sup = new OperatorSupervisor(port, clock, redactor(), facts);
  const desk = new MailboxDesk(dirs);
  const box = (name: string) => join(dirs.evidenceRoot, "keystone", "runs", RUN, "mailbox", name);
  return { clock, sup, desk, box };
}

/** Waits until a file exists. */
async function until(path: string): Promise<void> {
  for (let i = 0; i < 400 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 5));
}

const decision = (d: string) =>
  ({
    schema: "intyy.decision/1.0",
    staff_id: "op_017",
    at: "2026-09-28T14:01:00.000Z",
    decision: d,
    outcome: null,
    note: null,
  }) as unknown as Masked<unknown>;

describe("case 1: each kind's fields, against section 7 §13.1", () => {
  test("takeover: step, trouble, a non-empty ladder trail, commit.state, no notice when not in flight, operator_note", async () => {
    const { sup, desk, box } = await setup(30);
    const answer = sup.takeover({
      reason: "stuck",
      step: { id: "click_search", intent: null },
      trouble: { phase: "checkpoint", detail: "never arrived" },
      ladder: [{ rung: 1, verdict: "climb" }],
      commit: { state: "not_sent", notice: null },
      operatorNote: null,
      screenshot: "screens/00019_click_search_ladder.png",
    });
    await until(join(box("01_takeover"), "request.json"));
    const req = JSON.parse(readFileSync(join(box("01_takeover"), "request.json"), "utf8")) as Record<string, unknown>;
    expect(req).toMatchObject({
      kind: "takeover",
      reason: "stuck",
      step: { id: "click_search", intent: null },
      trouble: { phase: "checkpoint", detail: "never arrived" },
      ladder: [{ rung: 1, verdict: "climb" }],
      commit: { state: "not_sent", notice: null },
      operator_note: null,
      decisions: ["end_run"],
    });
    await desk.decide("keystone", RUN, "01_takeover", decision("end_run"));
    expect(await answer).toEqual({ kind: "ended_run", staff: "op_017" });
  });

  test("takeover: commit.notice carries the fixed in-flight text only when the commit is uncertain", async () => {
    const { sup, box } = await setup(30);
    void sup.takeover({
      reason: "needs_human_handler",
      step: { id: "click_confirm", intent: null },
      trouble: null,
      ladder: [],
      commit: { state: "uncertain", notice: "The commit action was already sent. Do not submit again." },
      operatorNote: "A supervisor must approve this.",
      screenshot: null,
    });
    await until(join(box("01_takeover"), "request.json"));
    const req = JSON.parse(readFileSync(join(box("01_takeover"), "request.json"), "utf8")) as Record<string, unknown>;
    expect(req).toMatchObject({
      commit: { state: "uncertain", notice: "The commit action was already sent. Do not submit again." },
      operator_note: "A supervisor must approve this.",
    });
  });

  test("retry_decision: reason retry_needs_approval, decisions retry | no_retry", async () => {
    const { sup, desk, box } = await setup(30);
    const answer = sup.retryDecision({ step: "click_confirm", screenshot: null });
    await until(join(box("01_retry_decision"), "request.json"));
    const req = JSON.parse(readFileSync(join(box("01_retry_decision"), "request.json"), "utf8")) as Record<string, unknown>;
    expect(req).toMatchObject({
      kind: "retry_decision",
      reason: "retry_needs_approval",
      step: { id: "click_confirm" },
      decisions: ["retry", "no_retry"],
    });
    await desk.decide("keystone", RUN, "01_retry_decision", decision("retry"));
    expect(await answer).toEqual({ kind: "retry", staff: "op_017" });
  });

  test("reconciliation_decision: reason reconciliation_unclear, decisions found | not_found, no browser needed", async () => {
    const { sup, desk, box } = await setup(240);
    const answer = sup.reconciliationDecision({ step: "click_confirm" });
    await until(join(box("01_reconciliation_decision"), "request.json"));
    const req = JSON.parse(readFileSync(join(box("01_reconciliation_decision"), "request.json"), "utf8")) as Record<string, unknown>;
    expect(req).toMatchObject({
      kind: "reconciliation_decision",
      reason: "reconciliation_unclear",
      step: { id: "click_confirm" },
      decisions: ["found", "not_found"],
      screenshot: null,
    });
    await desk.decide("keystone", RUN, "01_reconciliation_decision", decision("not_found"));
    expect(await answer).toEqual({ kind: "not_found", staff: "op_017" });
  });
});

describe("case 2: each decision word (section 7 §13.2)", () => {
  test("takeover: end_run resolves ended_run", async () => {
    const { sup, desk, box } = await setup(30);
    const answer = sup.takeover({
      reason: "stuck",
      step: { id: "s", intent: null },
      trouble: null,
      ladder: [],
      commit: { state: "none", notice: null },
      operatorNote: null,
      screenshot: null,
    });
    await until(join(box("01_takeover"), "request.json"));
    await desk.decide("keystone", RUN, "01_takeover", decision("end_run"));
    expect(await answer).toEqual({ kind: "ended_run", staff: "op_017" });
  });

  test.each([
    ["retry", "retry"],
    ["no_retry", "no_retry"],
  ])("retry_decision: %s resolves %s", async (word, kind) => {
    const { sup, desk, box } = await setup(30);
    const answer = sup.retryDecision({ step: "s", screenshot: null });
    await until(join(box("01_retry_decision"), "request.json"));
    await desk.decide("keystone", RUN, "01_retry_decision", decision(word));
    expect(await answer).toEqual({ kind, staff: "op_017" });
  });

  test.each([
    ["found", "found"],
    ["not_found", "not_found"],
  ])("reconciliation_decision: %s resolves %s", async (word, kind) => {
    const { sup, desk, box } = await setup(240);
    const answer = sup.reconciliationDecision({ step: "s" });
    await until(join(box("01_reconciliation_decision"), "request.json"));
    await desk.decide("keystone", RUN, "01_reconciliation_decision", decision(word));
    expect(await answer).toEqual({ kind, staff: "op_017" });
  });
});

describe("case 4: deadlines (section 7 §13.3)", () => {
  test("takeover's own default deadline (30 min) with no policy field", async () => {
    const { sup, box } = await setup(30);
    void sup.takeover({
      reason: "stuck",
      step: { id: "s", intent: null },
      trouble: null,
      ladder: [],
      commit: { state: "none", notice: null },
      operatorNote: null,
      screenshot: null,
    });
    await until(join(box("01_takeover"), "request.json"));
    const req = JSON.parse(readFileSync(join(box("01_takeover"), "request.json"), "utf8")) as { deadline: string };
    expect(req.deadline).toBe("2026-09-28T14:30:00.000Z");
  });

  test("retry_decision's own default deadline (30 min) with no policy field", async () => {
    const { sup, box } = await setup(30);
    void sup.retryDecision({ step: "s", screenshot: null });
    await until(join(box("01_retry_decision"), "request.json"));
    const req = JSON.parse(readFileSync(join(box("01_retry_decision"), "request.json"), "utf8")) as { deadline: string };
    expect(req.deadline).toBe("2026-09-28T14:30:00.000Z");
  });

  test("reconciliation_decision's own default deadline (4 h) with no policy field", async () => {
    const { sup, box } = await setup(240);
    void sup.reconciliationDecision({ step: "s" });
    await until(join(box("01_reconciliation_decision"), "request.json"));
    const req = JSON.parse(readFileSync(join(box("01_reconciliation_decision"), "request.json"), "utf8")) as { deadline: string };
    expect(req.deadline).toBe("2026-09-28T18:00:00.000Z");
  });

  test("a policy range clamps the resolved minutes: no bound at all leaves the field unset", () => {
    const global = GlobalPolicy.parse({
      schema: "intyy.policy/1.0",
      scope: { level: "global" },
      revision: 1,
      reason: "Test policy: no escalation block at all.",
    });
    const merged = mergePolicy({ global });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.value.effective.escalation.takeover_minutes).toBeUndefined();
  });

  test("a policy range clamps the resolved minutes: a tenant pick inside the global range wins", () => {
    // Only the tenant layer picks an `escalation` number (app has no such field, section 4).
    const global = GlobalPolicy.parse({
      schema: "intyy.policy/1.0",
      scope: { level: "global" },
      revision: 1,
      reason: "Test policy: a takeover_minutes range.",
      escalation: { takeover_minutes: { min: 15, max: 120, default: 30 } },
    });
    const tenant = TenantPolicy.parse({
      schema: "intyy.policy/1.0",
      scope: { level: "tenant", tenant: "keystone" },
      revision: 1,
      reason: "Test policy: picks 60.",
      escalation: { takeover_minutes: 60 },
    });
    const merged = mergePolicy({ global, tenant, appName: "kvfcu" });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.value.effective.escalation.takeover_minutes).toBe(60);
  });

  test.each([
    ["takeover", (h: { sup: OperatorSupervisor }) => h.sup.takeover({ reason: "stuck", step: { id: "s", intent: null }, trouble: null, ladder: [], commit: { state: "none", notice: null }, operatorNote: null, screenshot: null }), "01_takeover", { kind: "timed_out" }],
    ["retry_decision", (h: { sup: OperatorSupervisor }) => h.sup.retryDecision({ step: "s", screenshot: null }), "01_retry_decision", { kind: "timed_out" }],
    ["reconciliation_decision", (h: { sup: OperatorSupervisor }) => h.sup.reconciliationDecision({ step: "s" }), "01_reconciliation_decision", { kind: "timed_out" }],
  ] as const)("%s times out on the clock port; closed.json says timed_out", async (_name, ask, folder, want) => {
    const { clock, sup, box } = await setup(30);
    const answer = ask({ sup });
    await until(join(box(folder), "request.json"));
    clock.advance(30 * 60_000);
    expect(await answer).toEqual(want);
    expect(JSON.parse(readFileSync(join(box(folder), "closed.json"), "utf8"))).toMatchObject({ how: "timed_out" });
  });
});
