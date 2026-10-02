// Proves the crash sweep's M07 rows (design section 7 §17): every open mailbox request closes as
// `run_ended`; the lease ends at `nobody` with reason `run_end`; a commit is `confirmed` by a
// later passed checkpoint `check` line (run or watcher), not by a guess; a person who sent the
// commit is `performed_by: human`; and a crash while a person held control says so. Also proves
// the lines the sweep reads: the replay's `check` line for the commit checkpoint, and capture's
// `commit` flag on the `human_irreversible_action` warning. `MailboxDesk.closeRequest` writes
// `closed.json` once. Design section 7 §14.4, §15, §17; section 9 §10.5; docs/decisions.md, M07 task 8.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FileEvidenceStore } from "../../../src/adapters/files/other-stores.js";
import { MailboxDesk } from "../../../src/adapters/mailbox/mailbox.js";
import { Artifact as ArtifactSchema, type Artifact } from "../../../src/core/model/artifact.js";
import { CandidateDecision } from "../../../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../../../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../../../src/core/model/candidate-runs.js";
import { runSweep, type SweepDeps } from "../../../src/core/orchestrator/sweep.js";
import { runReplay, type ReplayDeps } from "../../../src/core/replay/executor.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { FakeCandidateStore } from "../../../src/fakes/stores.js";
import { FakeOperator, type FakeAnswer } from "../../../src/fakes/operator.js";
import { SnapshotSurface, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import type { Masked } from "../../../src/ports/masked.js";
import { toFactory } from "../../../src/ports/hands.js";
import type { InterventionDesk, OpenRequest } from "../../../src/ports/operator.js";
import { ok } from "../../../src/ports/outcome.js";
import { HoldingClock } from "../handoff/kit.js";
import {
  CHECK_SUB,
  OPEN_SUB,
  SIGN_IN,
  authorizationFor,
  buildHarness,
  fixtureSite,
  replayInputOf,
  requestOf,
} from "../replay/executor-harness.js";
import { tempRoot } from "../safety/canary-kit.js";
import { TENANT, harness, line, maskedCast, readBack, runStartData, seedCrashedRun } from "./sweep-kit.js";

type Line = { seq: number; at: string; step: string | null; by: string; why?: { ref?: string }; event: string; data: Record<string, unknown> };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const T0 = "2026-01-15T09:00:00.000Z";
const at = (s: number): string => `2026-01-15T09:00:${String(s).padStart(2, "0")}.000Z`;

/** What the sweep read back from one swept run. */
async function eventsOf(deps: SweepDeps, runId: string): Promise<Line[]> {
  const ev = await deps.evidence.events(TENANT, runId);
  if (!ev.ok) throw new Error("events failed");
  return ev.value as Line[];
}
const resultOf = async (deps: SweepDeps, runId: string): Promise<Record<string, unknown>> =>
  (await readBack(deps, runId)).result as Record<string, unknown>;
const effectOf = async (deps: SweepDeps, runId: string): Promise<Record<string, unknown> | undefined> =>
  (await resultOf(deps, runId)).effect as Record<string, unknown> | undefined;

const RUN = "run_2026-01-15_1000000030";
const start = (id: string, artifact = "kvfcu/open_sub@1.0.0"): unknown => line(1, T0, null, "run_start", runStartData(artifact, id));
const intent = (seq: number): unknown => line(seq, at(1), "click_confirm", "commit_intent", {});
const leaseLine = (seq: number, from: string, to: string, reason: string): unknown =>
  line(seq, at(seq), null, "lease", { from, to, reason, staff_id: null, implicit: false });
const checkLine = (seq: number, extra: Record<string, unknown> = {}): unknown =>
  line(seq, at(seq), "click_confirm", "check", { condition: "done_shown", role: "checkpoint", passed: true, ...extra });
const humanWarning = (seq: number, commit: boolean, step = "type_member_id"): unknown =>
  line(seq, at(seq), step, "warning", { code: "human_irreversible_action", detail: "x", commit });

// ---- A stub desk ---------------------------------------------------------------------------

/** An in-memory mailbox for one run: folders, each open or closed with a `how`. */
class StubDesk implements InterventionDesk {
  readonly closed = new Map<string, string>();
  readonly calls: string[] = [];
  constructor(readonly folders: string[]) {}

  openRequest(): Promise<ReturnType<typeof ok<OpenRequest | null>>> {
    const open = [...this.folders].sort().reverse().find((f) => !this.closed.has(f));
    return Promise.resolve(
      ok(open === undefined ? null : { folder: open, request: {}, decided: false, claim: null, released: false, runDir: "/none" }),
    );
  }
  closeRequest(_t: string, _r: string, folder: string, body: Masked<unknown>) {
    this.calls.push(folder);
    if (!this.closed.has(folder)) this.closed.set(folder, (body as unknown as { how: string }).how);
    return Promise.resolve(ok(undefined));
  }
  decide(): never {
    throw new Error("not used");
  }
  claim(): never {
    throw new Error("not used");
  }
  release(): never {
    throw new Error("not used");
  }
  dialog(): never {
    throw new Error("not used");
  }
}

describe("open requests close run_ended (section 7 §17)", () => {
  test("the sweep closes every open request run_ended, keeps an earlier how, and works with no desk", async () => {
    // two open requests both close, and none is open afterwards
    {
      const desk = new StubDesk(["01_approval", "02_takeover"]);
      const deps = await harness(desk);
      await seedCrashedRun(deps, RUN, { kind: "replay", capability: "kvfcu/open_sub", events: [start(RUN)] });
      await runSweep(deps, TENANT);
      expect([...desk.closed.entries()].sort()).toEqual([
        ["01_approval", "run_ended"],
        ["02_takeover", "run_ended"],
      ]);
      expect(await desk.openRequest()).toEqual(ok(null));
    }
    // a request that already closed keeps its own how
    {
      const desk = new StubDesk(["01_approval", "02_takeover"]);
      desk.closed.set("01_approval", "timed_out");
      const deps = await harness(desk);
      await seedCrashedRun(deps, RUN, { kind: "replay", capability: "kvfcu/open_sub", events: [start(RUN)] });
      await runSweep(deps, TENANT);
      expect(desk.closed.get("01_approval")).toBe("timed_out");
      expect(desk.closed.get("02_takeover")).toBe("run_ended");
    }
    // with no desk nothing closes, and the run is still swept
    {
      const desk = new StubDesk(["01_takeover"]);
      const deps = await harness();
      await seedCrashedRun(deps, RUN, { kind: "replay", capability: "kvfcu/open_sub", events: [start(RUN)] });
      const report = await runSweep(deps, TENANT);
      expect(report.closed).toBe(1);
      expect(desk.closed.size).toBe(0);
      expect(desk.calls).toEqual([]);
    }
  });
});

describe("the lease ends at nobody (section 7 §12.2, §17)", () => {
  const leaseLines = (lines: Line[]): Line[] => lines.filter((l) => l.event === "lease");

  test("the sweep ends a bot or human lease at nobody and adds no line when it already ended", async () => {
    // a log that ends on a bot lease gets a lease line to nobody, reason run_end, just before run_end
    {
      const deps = await harness();
      await seedCrashedRun(deps, RUN, {
        kind: "replay",
        capability: "kvfcu/open_sub",
        events: [start(RUN), leaseLine(2, "nobody", "bot", "run_start")],
      });
      await runSweep(deps, TENANT);
      const lines = await eventsOf(deps, RUN);
      const added = leaseLines(lines)[1];
      expect(added).toMatchObject({
        by: "engine",
        why: { kind: "engine_rule", ref: "run_end" },
        data: { from: "bot", to: "nobody", reason: "run_end", staff_id: null, implicit: false },
      });
      const runEnd = lines.find((l) => l.event === "run_end");
      expect(added?.seq).toBe(3);
      expect(runEnd?.seq).toBe(4);
    }
    // a log that already ends on nobody, or has no lease line at all, gets no new lease line
    {
      const deps = await harness();
      await seedCrashedRun(deps, RUN, {
        kind: "replay",
        capability: "kvfcu/open_sub",
        events: [start(RUN), leaseLine(2, "nobody", "bot", "run_start"), leaseLine(3, "bot", "nobody", "takeover_requested")],
      });
      const other = "run_2026-01-15_1000000031";
      await seedCrashedRun(deps, other, { kind: "replay", capability: "kvfcu/open_sub", events: [start(other)] });
      await runSweep(deps, TENANT);
      expect(leaseLines(await eventsOf(deps, RUN))).toHaveLength(2);
      expect(leaseLines(await eventsOf(deps, other))).toHaveLength(0);
    }
    // a log that ends on a human lease: the lease line is from human, and the message says a person held control
    {
      const deps = await harness();
      await seedCrashedRun(deps, RUN, {
        kind: "replay",
        capability: "kvfcu/open_sub",
        events: [
          start(RUN),
          leaseLine(2, "nobody", "bot", "run_start"),
          leaseLine(3, "bot", "nobody", "takeover_requested"),
          leaseLine(4, "nobody", "human", "claimed"),
        ],
      });
      await runSweep(deps, TENANT);
      const added = leaseLines(await eventsOf(deps, RUN)).at(-1);
      expect(added).toMatchObject({ data: { from: "human", to: "nobody", reason: "run_end" } });
      const failure = (await resultOf(deps, RUN)).failure as Record<string, unknown>;
      expect(String(failure.message)).toContain("a person held control");
    }
    // a log that ends on a bot lease does not mention a person
    {
      const deps = await harness();
      await seedCrashedRun(deps, RUN, {
        kind: "replay",
        capability: "kvfcu/open_sub",
        events: [start(RUN), leaseLine(2, "nobody", "bot", "run_start")],
      });
      await runSweep(deps, TENANT);
      expect(String(((await resultOf(deps, RUN)).failure as Record<string, unknown>).message)).not.toContain("a person");
    }
  });
});

describe("confirmed by a passed checkpoint line (section 7 §17, §15)", () => {
  /** A crashed log: the commit went out at seq 2, then `extra` lines. */
  async function sweepWith(extra: unknown[], artifact = "kvfcu/open_sub@1.0.0"): Promise<string> {
    const deps = await harness();
    await seedCrashedRun(deps, RUN, {
      kind: "replay",
      capability: "kvfcu/open_sub",
      events: [start(RUN, artifact), intent(2), ...extra],
    });
    const report = await runSweep(deps, TENANT);
    return String(report.runs?.[0]?.commit);
  }

  test("the sweep confirms a commit only by a passed checkpoint line after the intent", async () => {
    // a passed check proves the commit only for a checkpoint or watch role, on this condition, after the intent
    {
      const rows: [string, Record<string, unknown>, string][] = [
        ["a passed checkpoint check by the run", { role: "checkpoint" }, "confirmed"],
        ["a passed check by a watcher while a person drove", { role: "watch" }, "confirmed"],
        ["a check that did not pass", { passed: false }, "uncertain"],
        ["a passed check of another condition", { condition: "home_shown" }, "uncertain"],
        ["a passed check by the sweep's own role", { role: "sweep" }, "uncertain"],
        ["a passed check by a handler", { role: "handler" }, "uncertain"],
      ];
      for (const [name, change, want] of rows) {
        expect(await sweepWith([checkLine(3, change)]), name).toBe(want);
      }
    }
    // a passed check from before the commit_intent proves nothing
    {
      const deps = await harness();
      await seedCrashedRun(deps, RUN, {
        kind: "replay",
        capability: "kvfcu/open_sub",
        events: [start(RUN), checkLine(2), intent(3)],
      });
      const report = await runSweep(deps, TENANT);
      expect(report.runs?.[0]?.commit).toBe("uncertain");
    }
    // an artifact the sweep cannot read: no check line proves anything
    {
      expect(await sweepWith([checkLine(3)], "kvfcu/vanished_cap@9.9.9")).toBe("uncertain");
    }
  });
});

describe("who sent the commit (section 7 §14.4, §17)", () => {
  test("the sweep names who sent the commit from the intent and the person's warning", async () => {
    // a person's commit warning with no commit_intent: performed_by human, sent_at the warning's time, uncertain
    {
      const deps = await harness();
      await seedCrashedRun(deps, RUN, {
        kind: "replay",
        capability: "kvfcu/open_sub",
        events: [start(RUN), humanWarning(2, true)],
      });
      await runSweep(deps, TENANT);
      expect(await effectOf(deps, RUN)).toMatchObject({ commit: "uncertain", performed_by: "human", sent_at: at(2) });
    }
    // the same, with a passed checkpoint line after it: confirmed
    {
      const deps = await harness();
      await seedCrashedRun(deps, RUN, {
        kind: "replay",
        capability: "kvfcu/open_sub",
        events: [start(RUN), humanWarning(2, true), checkLine(3, { role: "watch" })],
      });
      await runSweep(deps, TENANT);
      expect(await effectOf(deps, RUN)).toMatchObject({ commit: "confirmed", performed_by: "human" });
    }
    // a warning that says commit: false proves no send: not_sent, no performer
    {
      const deps = await harness();
      await seedCrashedRun(deps, RUN, {
        kind: "replay",
        capability: "kvfcu/open_sub",
        events: [start(RUN), humanWarning(2, false)],
      });
      await runSweep(deps, TENANT);
      expect(await effectOf(deps, RUN)).toMatchObject({ commit: "not_sent", performed_by: null, sent_at: null });
    }
    // with a commit_intent the bot sent it, whatever a warning says
    {
      const deps = await harness();
      await seedCrashedRun(deps, RUN, {
        kind: "replay",
        capability: "kvfcu/open_sub",
        // Same step as the intent, so no later step's line confirms it.
        events: [start(RUN), intent(2), humanWarning(3, true, "click_confirm")],
      });
      await runSweep(deps, TENANT);
      expect(await effectOf(deps, RUN)).toMatchObject({ commit: "uncertain", performed_by: "bot", sent_at: at(1) });
    }
    // a read_only capability gets no effect block, even with a person's warning
    {
      const deps = await harness();
      await seedCrashedRun(deps, RUN, {
        kind: "replay",
        capability: "kvfcu/sign_in",
        events: [start(RUN, "kvfcu/sign_in@1.0.0"), humanWarning(2, true)],
      });
      await runSweep(deps, TENANT);
      expect("effect" in (await resultOf(deps, RUN))).toBe(false);
    }
  });
});

describe("MailboxDesk.closeRequest (section 9 §10.5)", () => {
  async function mailbox() {
    const { root, remove } = await tempRoot("intyy-sweep-desk-");
    cleanups.push(remove);
    const dirs = { evidenceRoot: join(root, "evidence"), tmpDir: join(root, "tmp") };
    const box = (name: string): string => join(dirs.evidenceRoot, TENANT, "runs", RUN, "mailbox", name);
    const request = async (name: string): Promise<void> => {
      await mkdir(box(name), { recursive: true });
      await writeFile(join(box(name), "request.json"), JSON.stringify({ kind: "takeover" }));
    };
    return { root, dirs, box, request, desk: new MailboxDesk(dirs) };
  }
  const closedBody = (how: string): Masked<unknown> => maskedCast({ schema: "intyy.closed/1.0", how, at: T0 });

  test("writes closed.json once: a second call succeeds and keeps the first", async () => {
    const m = await mailbox();
    await m.request("01_takeover");
    expect(await m.desk.closeRequest(TENANT, RUN, "01_takeover", closedBody("run_ended"))).toEqual(ok(undefined));
    expect(await m.desk.closeRequest(TENANT, RUN, "01_takeover", closedBody("timed_out"))).toEqual(ok(undefined));
    const file = JSON.parse(await readFile(join(m.box("01_takeover"), "closed.json"), "utf8")) as { how: string };
    expect(file.how).toBe("run_ended");
    expect(await m.desk.openRequest(TENANT, RUN)).toEqual(ok(null));
  });

  test("a real sweep over real files closes every open request and keeps one that closed itself", async () => {
    const m = await mailbox();
    const evidence = new FileEvidenceStore({ root: m.dirs.evidenceRoot, tmpDir: m.dirs.tmpDir });
    const deps: SweepDeps = { ...(await harness(m.desk)), evidence };
    await seedCrashedRun(deps, RUN, { kind: "replay", capability: "kvfcu/open_sub", events: [start(RUN)] });
    await m.request("01_approval");
    await m.request("02_takeover");
    await m.request("03_retry");
    await writeFile(join(m.box("01_approval"), "closed.json"), JSON.stringify({ schema: "intyy.closed/1.0", how: "timed_out", at: T0 }));

    await runSweep(deps, TENANT);
    const how = async (f: string): Promise<string> =>
      (JSON.parse(await readFile(join(m.box(f), "closed.json"), "utf8")) as { how: string }).how;
    expect(await how("01_approval")).toBe("timed_out");
    expect(await how("02_takeover")).toBe("run_ended");
    expect(await how("03_retry")).toBe("run_ended");
    expect(await m.desk.openRequest(TENANT, RUN)).toEqual(ok(null));
  });
});

// ---- What the replay writes for the sweep to read ---------------------------------------------

const OUTCOME = "member_not_found";
const COMMIT_DECLARES: Artifact = {
  ...OPEN_SUB,
  steps: OPEN_SUB.steps.map((s) => (s.id === "click_confirm" ? { ...s, outcomes: [OUTCOME] } : s)),
};

/** The replay of `open_sub` on `site`, and its log. */
async function replayOn(site: FakeSite, opts: { artifact?: Artifact; overrides?: Partial<ReplayDeps> } = {}) {
  const h = await buildHarness(site, opts.overrides ?? {});
  if (opts.artifact !== undefined) {
    // Seal the changed task artifact in place of the fixture one.
    const store = new FakeCandidateStore(
      {
        files: { "runs.json": CandidateRuns, "candidate.json": ArtifactSchema, "issues.json": CandidateIssues },
        decision: CandidateDecision,
      },
      new SteppingClock(),
    );
    await store.seal("kvfcu/sign_in/cand_2026-01-15_1000000001", "1.0.0", "op_017", SIGN_IN, {});
    await store.seal("kvfcu/open_sub/cand_2026-01-15_1000000002", "1.0.0", "op_017", opts.artifact, {});
    await store.seal("kvfcu/check_sub/cand_2026-01-15_1000000003", "1.0.0", "op_017", CHECK_SUB, {});
    h.deps.artifacts = store;
  }
  const input = replayInputOf(h, requestOf({ authorization: authorizationFor("kvfcu/open_sub@1") }));
  const { runId, result } = await runReplay(input, h.deps);
  const ev = await h.deps.evidence.events(TENANT, runId);
  if (!ev.ok) throw new Error("events failed");
  return { result, lines: ev.value as Line[] };
}

const checkpointLines = (lines: Line[]): Line[] => lines.filter((l) => l.event === "check" && l.data["role"] === "checkpoint");

describe("the replay's checkpoint check line (section 3 §6.4, section 7 §17)", () => {
  test("a commit that confirms: one passed line, after commit_intent, with waited_ms", async () => {
    const { result, lines } = await replayOn(fixtureSite());
    expect(result.status).toBe("success");
    const checks = checkpointLines(lines);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ step: "click_confirm", by: "engine", data: { condition: "done_shown", passed: true } });
    expect(typeof checks[0]?.data["waited_ms"]).toBe("number");
    const intentAt = lines.findIndex((l) => l.event === "commit_intent");
    expect(lines.indexOf(checks[0] as Line)).toBeGreaterThan(intentAt);
  });

  test("a checkpoint that never shows: one failed line", async () => {
    const { lines } = await replayOn(fixtureSite({ confirm: "stuck" }));
    const checks = checkpointLines(lines);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ data: { condition: "done_shown", passed: false } });
  });

  test("a declared outcome that wins the race: no checkpoint line", async () => {
    const site = fixtureSite();
    const result = site.screens["/result"];
    if (result === undefined) throw new Error("no /result");
    const moved: FakeSite = {
      ...site,
      screens: {
        ...site.screens,
        "/result": { ...result, elements: [{ ...(result.elements[0] as NonNullable<typeof result.elements[0]>), onClick: { go: "/check" } }] },
        "/check": { elements: [{ id: "nf", role: "generic", roleGroup: "container", text: "No member found" }] },
      },
    };
    const { result: out, lines } = await replayOn(moved, { artifact: COMMIT_DECLARES });
    expect(out.status).toBe("business_outcome");
    expect(checkpointLines(lines)).toEqual([]);
  });

  test("a real replay's log cut right after that line sweeps to confirmed; cut before it, uncertain", async () => {
    const { lines } = await replayOn(fixtureSite());
    const passed = lines.findIndex((l) => l.event === "check" && l.data["role"] === "checkpoint");
    // Nothing after the check line may come from another step, or that alone would confirm it.
    const afterIntent = lines.slice(lines.findIndex((l) => l.event === "commit_intent"), passed + 1);
    expect(afterIntent.every((l) => l.step === "click_confirm" || l.step === null)).toBe(true);

    for (const [cut, want] of [
      [passed + 1, "confirmed"],
      [passed, "uncertain"],
    ] as const) {
      const deps = await harness();
      const id = `run_2026-01-15_10000000${want === "confirmed" ? "40" : "41"}`;
      await seedCrashedRun(deps, id, { kind: "replay", capability: "kvfcu/open_sub", events: lines.slice(0, cut) });
      const report = await runSweep(deps, TENANT);
      expect(report.runs?.[0]).toMatchObject({ runId: id, commit: want });
    }
  });
});

// ---- Capture's commit flag --------------------------------------------------------------------

describe("the human_irreversible_action warning's commit flag (section 7 §14.4)", () => {
  /** A replay stopped by a person, who then acts; the takeover ends at once. */
  async function personActs(act: (s: SnapshotSurface) => void, site: FakeSite) {
    const surface = new SnapshotSurface(site);
    const answers: FakeAnswer[] = ["silent", { staff: "op_017", claimed: true }, { act: () => { act(surface); } }, { staff: "op_017", decision: "end_run" }];
    const operator = new FakeOperator(answers);
    const h = await buildHarness(site, {
      clock: new HoldingClock(),
      surface: toFactory(surface),
      operator: () => operator,
      reconciliationCheck: () => Promise.resolve({ kind: "found_outputs_unavailable" }),
    });
    const input = replayInputOf(h, requestOf({ authorization: authorizationFor("kvfcu/open_sub@1") }));
    const running = runReplay(input, h.deps);
    await vi.waitFor(() => {
      expect(operator.requests.length).toBe(1);
    });
    surface.humanInput();
    const { runId } = await running;
    const ev = await h.deps.evidence.events(TENANT, runId);
    if (!ev.ok) throw new Error("events failed");
    return (ev.value as Line[]).filter((l) => l.event === "warning" && l.data["code"] === "human_irreversible_action");
  }

  /** The fixture site, with a Delete button on home (an irreversible word) and the usual search. */
  function siteWithDelete(): FakeSite {
    const site = fixtureSite();
    const home = site.screens["/home"];
    if (home === undefined) throw new Error("no /home");
    return {
      ...site,
      screens: {
        ...site.screens,
        "/home": {
          ...home,
          elements: [...home.elements, { id: "delete_button", role: "button", roleGroup: "button_like", name: "Delete member", text: "Delete member" }],
        },
      },
    };
  }

  test("a click that sends the commit: commit true", async () => {
    const warnings = await personActs((s) => {
      s.humanInput({ type: "type", element: "member_id_box", value: "abc" });
      s.humanInput({ type: "click", element: "search_button" });
      s.humanInput({ type: "click", element: "confirm_button" });
    }, fixtureSite());
    expect(warnings.map((w) => w.data["commit"])).toEqual([true]);
  });

  test("an irreversible click that is not the commit: commit false", async () => {
    const warnings = await personActs((s) => {
      s.humanInput({ type: "click", element: "delete_button" });
    }, siteWithDelete());
    expect(warnings.map((w) => w.data["commit"])).toEqual([false]);
  });
});
