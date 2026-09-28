// Proves discovery approvals through the real mailbox: request.json written, the decision read,
// closed.json written on each ending; one decision only. Design section 9 §10.5, §16 ("Mailbox");
// section 7 §13.4; section 4 §7.7. M03 task 8.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MailboxDesk, MailboxOperator } from "../../../src/adapters/mailbox/mailbox.js";
import { OperatorSupervisor } from "../../../src/core/discovery/supervisor.js";
import { masked } from "../../../src/core/safety/redaction/compose.js";
import { ManualClock } from "../../../src/fakes/clock.js";
import type { Masked } from "../../../src/ports/masked.js";
import { tempRoot } from "../safety/canary-kit.js";
import { redactor } from "./kit.js";

const RUN = "run_2026-09-28_7kq2m9x4tb";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A mailbox in a temp folder, a supervisor on it, and the CLI's desk. */
async function setup() {
  const { root, remove } = await tempRoot("intyy-mail-");
  cleanups.push(remove);
  const dirs = { evidenceRoot: join(root, "evidence"), tmpDir: join(root, "tmp") };
  const clock = new ManualClock("2026-09-28T14:00:00.000Z");
  const port = new MailboxOperator(dirs, { tenant: "keystone", runId: RUN }, 5);
  const sup = new OperatorSupervisor(port, clock, redactor(), {
    runId: RUN,
    tenant: "keystone",
    capability: "kvfcu/transfer",
    deadlineMinutes: 30,
  });
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

const ask = {
  turn: 7,
  element: "e4",
  label: masked`Submit Transfer`,
  screenshot: "screens/00031_observation.png",
};

describe("discovery approvals on the mailbox", () => {
  test("request.json is written, the decision is read, closed.json says resolved", async () => {
    const { sup, desk, box } = await setup();
    const answer = sup.approve(ask);
    await until(join(box("01_approval"), "request.json"));
    const req = JSON.parse(
      readFileSync(join(box("01_approval"), "request.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(req).toMatchObject({
      schema: "intyy.intervention/1.0",
      run_id: RUN,
      kind: "approval",
      reason: "discovery_irreversible",
      step: { id: "t7" },
      approval: { words: "Submit Transfer", risk: "irreversible" },
      screenshot: "screens/00031_observation.png",
      deadline: "2026-09-28T14:30:00.000Z",
    });
    const open = await desk.openRequest("keystone", RUN);
    expect(open).toMatchObject({ ok: true, value: { folder: "01_approval", decided: false } });
    expect(
      await desk.decide("keystone", RUN, "01_approval", decision("approve_reversible")),
    ).toEqual({ ok: true, value: undefined });
    expect(await answer).toEqual({ kind: "decided", staff: "op_017", hint: "reversible" });
    expect(JSON.parse(readFileSync(join(box("01_approval"), "closed.json"), "utf8"))).toMatchObject(
      { how: "resolved" },
    );
    expect(await desk.openRequest("keystone", RUN)).toEqual({ ok: true, value: null });
  });

  test("a second decision is refused", async () => {
    const { sup, desk, box } = await setup();
    const answer = sup.approve(ask);
    await until(join(box("01_approval"), "request.json"));
    await desk.decide("keystone", RUN, "01_approval", decision("decline"));
    expect(
      await desk.decide("keystone", RUN, "01_approval", decision("approve_irreversible")),
    ).toMatchObject({ ok: false, failure: "already_decided" });
    expect(await answer).toEqual({ kind: "decided", staff: "op_017", hint: null });
  });

  test("the deadline times the request out on the clock port", async () => {
    const { clock, sup, box } = await setup();
    const answer = sup.approve(ask);
    await until(join(box("01_approval"), "request.json"));
    clock.advance(30 * 60_000);
    expect(await answer).toEqual({ kind: "timed_out" });
    expect(JSON.parse(readFileSync(join(box("01_approval"), "closed.json"), "utf8"))).toMatchObject(
      { how: "timed_out" },
    );
  });

  test("the run's end closes the request run_ended", async () => {
    const { sup, box } = await setup();
    const stop = new AbortController();
    const answer = sup.approve(ask, stop.signal);
    await until(join(box("01_approval"), "request.json"));
    stop.abort();
    expect(await answer).toEqual({ kind: "run_ended" });
    expect(JSON.parse(readFileSync(join(box("01_approval"), "closed.json"), "utf8"))).toMatchObject(
      { how: "run_ended" },
    );
  });

  test("a stuck request offers end_run only, in its own folder", async () => {
    const { sup, desk, box } = await setup();
    const answer = sup.stuck({ turn: 3, reason: masked`No sign-in form.`, screenshot: null });
    await until(join(box("01_takeover"), "request.json"));
    const open = await desk.openRequest("keystone", RUN);
    expect(open.ok && open.value?.request).toMatchObject({
      kind: "takeover",
      reason: "stuck",
      decisions: ["end_run"],
    });
    await desk.decide("keystone", RUN, "01_takeover", decision("end_run"));
    expect(await answer).toEqual({ kind: "end_run", staff: "op_017" });
  });

  test("an unknown run is not_found", async () => {
    const { desk } = await setup();
    expect(await desk.openRequest("keystone", "run_2026-09-28_0000000000")).toMatchObject({
      ok: false,
      failure: "not_found",
    });
  });
});
