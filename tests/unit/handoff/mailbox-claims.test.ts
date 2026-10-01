// Proves claims on the real mailbox and the supervisor above it: the desk's exclusive claim (one
// winner, even in a race), a claim that moves a takeover's deadline (60 min, clamped 15 to 240,
// the old timer dead), dialog answers reaching the engine in order, the takeover decisions, and
// closed.json for each way a request ends. Design section 9 §10.4, §10.5; section 7 §13.2, §13.3,
// §13.4; docs/decisions.md, M07. M07 task 2.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MailboxDesk, MailboxOperator } from "../../../src/adapters/mailbox/mailbox.js";
import { OperatorSupervisor, type SupervisorFacts, type TakeoverAnswer } from "../../../src/core/discovery/supervisor.js";
import { ManualClock } from "../../../src/fakes/clock.js";
import type { Masked } from "../../../src/ports/masked.js";
import { redactor } from "../discovery/kit.js";
import { tempRoot } from "../safety/canary-kit.js";

const RUN = "run_2026-09-28_7kq2m9x4tb";
const START = "2026-09-28T14:00:00.000Z";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** Hooks' calls, in order. */
type Heard = { claims: { staff: string; implicit: boolean; deadline: string }[]; dialogs: { staff: string; answer: string }[] };

/** A mailbox in a temp folder, a manual clock, the CLI's desk, and a supervisor with hooks. */
async function setup(facts: Partial<SupervisorFacts> = {}) {
  const { root, remove } = await tempRoot("intyy-claim-");
  // Why: a test may leave a request open. Ending the run and waiting for the supervisor lets it
  // write closed.json before the temp folder goes (no write into a removed folder).
  const stop = new AbortController();
  const pending: Promise<unknown>[] = [];
  cleanups.push(async () => {
    stop.abort();
    await Promise.allSettled(pending);
    await remove();
  });
  const dirs = { evidenceRoot: join(root, "evidence"), tmpDir: join(root, "tmp") };
  const clock = new ManualClock(START);
  const port = new MailboxOperator(dirs, { tenant: "keystone", runId: RUN }, 5);
  const heard: Heard = { claims: [], dialogs: [] };
  const sup = new OperatorSupervisor(
    port,
    clock,
    redactor(),
    { runId: RUN, tenant: "keystone", capability: "kvfcu/open_sub", deadlineMinutes: 30, ...facts },
    {
      onClaim: (staff, implicit, deadline) => heard.claims.push({ staff, implicit, deadline }),
      onDialog: (staff, answer) => heard.dialogs.push({ staff, answer }),
    },
  );
  const desk = new MailboxDesk(dirs);
  const box = (name: string) => join(dirs.evidenceRoot, "keystone", "runs", RUN, "mailbox", name);
  return { clock, sup, desk, box, heard, port, stop, pending };
}

type Setup = Awaited<ReturnType<typeof setup>>;
const FOLDER = "01_takeover";

/** Opens a takeover that declares `outcomes`, and waits for its request file. */
async function openTakeover(s: Setup, outcomes: string[] = []): Promise<{ answer: Promise<TakeoverAnswer> }> {
  const answer = s.sup.takeover({
    reason: "stuck",
    step: { id: "click_search", intent: null },
    trouble: null,
    ladder: [],
    commit: { state: "none", notice: null },
    operatorNote: null,
    screenshot: null,
    outcomes,
  }, s.stop.signal);
  s.pending.push(answer);
  await vi.waitFor(() => {
    expect(existsSync(join(s.box(FOLDER), "request.json"))).toBe(true);
  });
  // Why a wrapper: an async function that returned the promise itself would wait for the answer.
  return { answer };
}

const claimBody = (staff: string, implicit = false) =>
  ({ schema: "intyy.claim/1.0", staff_id: staff, at: "2026-09-28T14:01:00.000Z", implicit }) as unknown as Masked<unknown>;
const releaseBody = (staff: string, note: string | null = null) =>
  ({ schema: "intyy.release/1.0", staff_id: staff, at: "2026-09-28T14:02:00.000Z", note }) as unknown as Masked<unknown>;
const dialogBody = (staff: string, answer: string) =>
  ({ staff_id: staff, at: "2026-09-28T14:02:00.000Z", answer }) as unknown as Masked<unknown>;
const decisionBody = (decision: string, outcome: string | null = null) =>
  ({
    schema: "intyy.decision/1.0",
    staff_id: "op_017",
    at: "2026-09-28T14:03:00.000Z",
    decision,
    outcome,
    note: null,
  }) as unknown as Masked<unknown>;

const closedHow = (s: Setup): unknown =>
  (JSON.parse(readFileSync(join(s.box(FOLDER), "closed.json"), "utf8")) as { how: string }).how;

describe("the desk's claim (section 9 §10.5: exclusive create)", () => {
  test("the first claim is ok, the second is already_claimed, and the first stays", async () => {
    const s = await setup();
    await openTakeover(s);
    expect(await s.desk.claim("keystone", RUN, FOLDER, claimBody("op_017"))).toEqual({ ok: true, value: undefined });
    expect(await s.desk.claim("keystone", RUN, FOLDER, claimBody("op_022"))).toMatchObject({
      ok: false,
      failure: "already_claimed",
    });
    const file = JSON.parse(readFileSync(join(s.box(FOLDER), "claim.json"), "utf8")) as { staff_id: string };
    expect(file.staff_id).toBe("op_017");
  });

  test("a concurrent pair of claims has exactly one winner", async () => {
    const s = await setup();
    await openTakeover(s);
    const staff = ["op_017", "op_022", "op_031", "op_040", "op_041", "op_042"];
    const results = await Promise.all(staff.map((id) => s.desk.claim("keystone", RUN, FOLDER, claimBody(id))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.failure === "already_claimed")).toHaveLength(staff.length - 1);
    const winner = staff[results.findIndex((r) => r.ok)];
    const file = JSON.parse(readFileSync(join(s.box(FOLDER), "claim.json"), "utf8")) as { staff_id: string };
    expect(file.staff_id).toBe(winner);
  });

  test("release is written once; a second release is already_released", async () => {
    const s = await setup();
    await openTakeover(s);
    expect(await s.desk.release("keystone", RUN, FOLDER, releaseBody("op_017"))).toEqual({ ok: true, value: undefined });
    expect(await s.desk.release("keystone", RUN, FOLDER, releaseBody("op_017"))).toMatchObject({
      ok: false,
      failure: "already_released",
    });
  });

  test("dialog answers append, one line each, in order", async () => {
    const s = await setup();
    await openTakeover(s);
    await s.desk.dialog("keystone", RUN, FOLDER, dialogBody("op_017", "accept"));
    await s.desk.dialog("keystone", RUN, FOLDER, dialogBody("op_017", "dismiss"));
    const lines = readFileSync(join(s.box(FOLDER), "dialogs.jsonl"), "utf8").trim().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as { answer: string }).answer)).toEqual(["accept", "dismiss"]);
  });

  test("openRequest reports the claim and the release", async () => {
    const s = await setup();
    await openTakeover(s);
    expect(await s.desk.openRequest("keystone", RUN)).toMatchObject({ ok: true, value: { claim: null, released: false } });
    await s.desk.claim("keystone", RUN, FOLDER, claimBody("op_017"));
    await s.desk.release("keystone", RUN, FOLDER, releaseBody("op_017"));
    expect(await s.desk.openRequest("keystone", RUN)).toMatchObject({
      ok: true,
      value: { claim: { staff_id: "op_017" }, released: true },
    });
  });
});

describe("a claim moves the takeover's deadline (section 7 §13.3)", () => {
  test("onClaim fires with the staff ID, and the deadline is the claim plus 60 minutes", async () => {
    const s = await setup();
    const { answer } = await openTakeover(s);
    s.clock.advance(10 * 60_000); // 14:10, inside the 30-minute claim window
    await s.desk.claim("keystone", RUN, FOLDER, claimBody("op_017"));
    await vi.waitFor(() => {
      expect(s.heard.claims).toHaveLength(1);
    });
    expect(s.heard.claims[0]).toEqual({ staff: "op_017", implicit: false, deadline: "2026-09-28T15:10:00.000Z" });

    // A timer at the old deadline (14:30) does nothing: the request stays open.
    s.clock.advance(20 * 60_000);
    await new Promise((r) => setTimeout(r, 40));
    expect(existsSync(join(s.box(FOLDER), "closed.json"))).toBe(false);

    // The new deadline (15:10) does time it out.
    s.clock.advance(40 * 60_000);
    expect(await answer).toEqual({ kind: "timed_out" });
    expect(closedHow(s)).toBe("timed_out");
  });

  test.each([
    [5, "2026-09-28T14:15:00.000Z"],
    [999, "2026-09-28T18:00:00.000Z"],
    [90, "2026-09-28T15:30:00.000Z"],
  ])("a policy value of %i minutes is clamped to 15 to 240: the deadline is %s", async (minutes, deadline) => {
    const s = await setup({ claimedMinutes: minutes });
    await openTakeover(s);
    await s.desk.claim("keystone", RUN, FOLDER, claimBody("op_017"));
    await vi.waitFor(() => {
      expect(s.heard.claims).toHaveLength(1);
    });
    expect(s.heard.claims[0]?.deadline).toBe(deadline);
  });

  test("an implicit claim is reported implicit", async () => {
    const s = await setup();
    await openTakeover(s);
    await s.desk.claim("keystone", RUN, FOLDER, claimBody("op_017", true));
    await vi.waitFor(() => {
      expect(s.heard.claims).toHaveLength(1);
    });
    expect(s.heard.claims[0]).toMatchObject({ staff: "op_017", implicit: true });
  });

  test("a claim on an approval does not move its deadline and does not end it", async () => {
    const s = await setup();
    const answer = s.sup.commitApproval({ step: "click_confirm", intent: "Confirm", screenshot: null }, s.stop.signal);
    s.pending.push(answer);
    await vi.waitFor(() => {
      expect(existsSync(join(s.box("01_approval"), "request.json"))).toBe(true);
    });
    await s.desk.claim("keystone", RUN, "01_approval", claimBody("op_017"));
    await new Promise((r) => setTimeout(r, 40));
    expect(s.heard.claims).toEqual([]);
    s.clock.advance(30 * 60_000);
    expect(await answer).toEqual({ kind: "timed_out" });
  });
});

describe("dialog answers (section 7 §13.4)", () => {
  test("each line reaches onDialog in order, and the wait goes on", async () => {
    const s = await setup();
    const { answer } = await openTakeover(s);
    await s.desk.claim("keystone", RUN, FOLDER, claimBody("op_017"));
    await s.desk.dialog("keystone", RUN, FOLDER, dialogBody("op_017", "accept"));
    await s.desk.dialog("keystone", RUN, FOLDER, dialogBody("op_017", "dismiss"));
    await vi.waitFor(() => {
      expect(s.heard.dialogs).toHaveLength(2);
    });
    expect(s.heard.dialogs).toEqual([
      { staff: "op_017", answer: "accept" },
      { staff: "op_017", answer: "dismiss" },
    ]);
    expect(existsSync(join(s.box(FOLDER), "closed.json"))).toBe(false);
    await s.desk.decide("keystone", RUN, FOLDER, decisionBody("end_run"));
    expect(await answer).toEqual({ kind: "ended_run", staff: "op_017" });
  });
});

describe("the takeover's decisions (section 7 §13.2)", () => {
  test("the request is claimable (lease nobody) and offers end_run alone, when no outcome is declared", async () => {
    const s = await setup();
    await openTakeover(s);
    const open = await s.desk.openRequest("keystone", RUN);
    expect(open.ok && open.value?.request).toMatchObject({ kind: "takeover", lease: "nobody", decisions: ["end_run"], outcomes: [] });
  });

  test("with a declared outcome the request also offers set_outcome, and lists the codes", async () => {
    const s = await setup();
    await openTakeover(s, ["member_not_found"]);
    const open = await s.desk.openRequest("keystone", RUN);
    expect(open.ok && open.value?.request).toMatchObject({
      decisions: ["end_run", "set_outcome"],
      outcomes: ["member_not_found"],
    });
  });

  test("set_outcome with a declared code resolves set_outcome with that code", async () => {
    const s = await setup();
    const { answer } = await openTakeover(s, ["member_not_found"]);
    await s.desk.claim("keystone", RUN, FOLDER, claimBody("op_017"));
    await s.desk.decide("keystone", RUN, FOLDER, decisionBody("set_outcome", "member_not_found"));
    expect(await answer).toEqual({ kind: "set_outcome", staff: "op_017", code: "member_not_found" });
    expect(closedHow(s)).toBe("resolved");
  });

  test.each([
    ["an undeclared code", "something_else"],
    ["no code at all", null],
  ])("set_outcome with %s ends the run as end_run", async (_name, code) => {
    const s = await setup();
    const { answer } = await openTakeover(s, ["member_not_found"]);
    await s.desk.decide("keystone", RUN, FOLDER, decisionBody("set_outcome", code));
    expect(await answer).toEqual({ kind: "ended_run", staff: "op_017" });
  });

  test("set_outcome when nothing is declared ends the run as end_run", async () => {
    const s = await setup();
    const { answer } = await openTakeover(s);
    await s.desk.decide("keystone", RUN, FOLDER, decisionBody("set_outcome", "member_not_found"));
    expect(await answer).toEqual({ kind: "ended_run", staff: "op_017" });
  });

  test("a release hands back: the supervisor returns released with the note, and closes resolved", async () => {
    const s = await setup();
    const { answer } = await openTakeover(s);
    await s.desk.claim("keystone", RUN, FOLDER, claimBody("op_017"));
    await s.desk.release("keystone", RUN, FOLDER, releaseBody("op_017", "Filled the form."));
    expect(await answer).toEqual({ kind: "released", staff: "op_017", note: "Filled the form." });
    expect(closedHow(s)).toBe("resolved");
  });

  test("a release with no note returns note null", async () => {
    const s = await setup();
    const { answer } = await openTakeover(s);
    await s.desk.release("keystone", RUN, FOLDER, releaseBody("op_017"));
    expect(await answer).toEqual({ kind: "released", staff: "op_017", note: null });
  });

  test("a release on an approval is ignored: only the decision ends it", async () => {
    const s = await setup();
    const answer = s.sup.commitApproval({ step: "click_confirm", intent: "Confirm", screenshot: null }, s.stop.signal);
    s.pending.push(answer);
    await vi.waitFor(() => {
      expect(existsSync(join(s.box("01_approval"), "request.json"))).toBe(true);
    });
    await s.desk.release("keystone", RUN, "01_approval", releaseBody("op_017"));
    await new Promise((r) => setTimeout(r, 40));
    expect(existsSync(join(s.box("01_approval"), "closed.json"))).toBe(false);
    await s.desk.decide("keystone", RUN, "01_approval", decisionBody("approved"));
    expect(await answer).toEqual({ kind: "approved", staff: "op_017" });
  });
});

describe("closed.json (section 9 §10.5)", () => {
  test("resolved after a decision, timed_out at the deadline, run_ended when the run stops", async () => {
    const resolved = await setup();
    const { answer: a } = await openTakeover(resolved);
    await resolved.desk.decide("keystone", RUN, FOLDER, decisionBody("end_run"));
    await a;
    expect(closedHow(resolved)).toBe("resolved");

    const timedOut = await setup();
    const { answer: b } = await openTakeover(timedOut);
    timedOut.clock.advance(30 * 60_000);
    expect(await b).toEqual({ kind: "timed_out" });
    expect(closedHow(timedOut)).toBe("timed_out");

    const ended = await setup();
    const stop = new AbortController();
    const c = ended.sup.takeover(
      {
        reason: "stuck",
        step: { id: "s", intent: null },
        trouble: null,
        ladder: [],
        commit: { state: "none", notice: null },
        operatorNote: null,
        screenshot: null,
      },
      stop.signal,
    );
    await vi.waitFor(() => {
      expect(existsSync(join(ended.box(FOLDER), "request.json"))).toBe(true);
    });
    stop.abort();
    expect(await c).toEqual({ kind: "run_ended" });
    expect(closedHow(ended)).toBe("run_ended");
  });

  test("a claimed takeover that the run stops closes run_ended, and one that is released closes resolved", async () => {
    const s = await setup();
    const stop = new AbortController();
    const answer = s.sup.takeover(
      {
        reason: "stuck",
        step: { id: "s", intent: null },
        trouble: null,
        ladder: [],
        commit: { state: "none", notice: null },
        operatorNote: null,
        screenshot: null,
      },
      stop.signal,
    );
    await vi.waitFor(() => {
      expect(existsSync(join(s.box(FOLDER), "request.json"))).toBe(true);
    });
    await s.desk.claim("keystone", RUN, FOLDER, claimBody("op_017"));
    await vi.waitFor(() => {
      expect(s.heard.claims).toHaveLength(1);
    });
    stop.abort();
    expect(await answer).toEqual({ kind: "run_ended" });
    expect(closedHow(s)).toBe("run_ended");
  });
});
