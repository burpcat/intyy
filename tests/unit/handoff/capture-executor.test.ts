// Proves human capture and the watcher through `runReplay`: typed text never reaches any file of
// the run folder, a person's click on Confirm makes the commit `uncertain` with `performed_by:
// human`, and the watcher settles an in-flight commit while a person drives (a passing checkpoint
// confirms it; a declared outcome refuses it and wins over the checkpoint). Design section 7
// §14.2, §14.4, §15; section 4 §7.10, §8.10; docs/decisions.md, M07. M07 task 3.
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FileCandidateStore, FileEvidenceStore } from "../../../src/adapters/files/other-stores.js";
import { Artifact as ArtifactSchema, type Artifact } from "../../../src/core/model/artifact.js";
import { CandidateDecision } from "../../../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../../../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../../../src/core/model/candidate-runs.js";
import type { CandidateFiles } from "../../../src/core/recorder/candidates.js";
import { runReplay } from "../../../src/core/replay/executor.js";
import { FakeOperator, type FakeAnswer } from "../../../src/fakes/operator.js";
import { SnapshotSurface, type FakeElement, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { toFactory } from "../../../src/ports/hands.js";
import { readTree, tempRoot } from "../safety/canary-kit.js";
import {
  CHECK_SUB,
  MEMBER_FOUND,
  OPEN_SUB,
  SIGN_IN,
  TENANT,
  authorizationFor,
  buildHarness,
  fixtureSite,
  replayInputOf,
  requestOf,
} from "../replay/executor-harness.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { HoldingClock } from "./kit.js";

type Line = { event: string; step: string | null; by: string; data: Record<string, unknown> };

const OUTCOME = "member_not_found";
const START = { staff: "op_017", decision: "approved" } as const;
const SECRET_TEXT = "TOPSECRET99";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** `open_sub` where the commit step also declares the `member_not_found` outcome. */
const COMMIT_DECLARES: Artifact = {
  ...OPEN_SUB,
  steps: OPEN_SUB.steps.map((s) => (s.id === "click_confirm" ? { ...s, outcomes: [OUTCOME] } : s)),
};

type Drive = {
  site: FakeSite;
  answers: FakeAnswer[];
  /** Start with a valid authorization (no commit approval), or without (an approval waits). */
  authorized: boolean;
  /** Touch the page once this many mailbox requests are open. */
  waitRequests: number;
  /** The person's hands on the page. */
  play: (surface: SnapshotSurface) => void;
  /** Wait for this to hold, then end the run. Left out, the script ends the run. */
  until?: (read: () => Promise<Line[]>) => Promise<void>;
  artifact?: Artifact;
  checks?: { calls: number };
};

/** One replay on a real file evidence store, with a person acting on the page. */
async function drive(d: Drive) {
  const { root, remove } = await tempRoot("intyy-cap-");
  cleanups.push(remove);
  const evidence = new FileEvidenceStore({ root: join(root, "evidence"), tmpDir: join(root, "tmp") });
  const operator = new FakeOperator(d.answers);
  const surface = new SnapshotSurface(d.site);
  const abort = new AbortController();
  const overrides: Parameters<typeof buildHarness>[1] = {
    clock: new HoldingClock(),
    evidence,
    surface: toFactory(surface),
    operator: () => operator,
    signal: abort.signal,
  };
  if (d.checks !== undefined) {
    const checks = d.checks;
    overrides.reconciliationCheck = () => {
      checks.calls += 1;
      return Promise.resolve({ kind: "found_outputs_unavailable" });
    };
  }
  const h = await buildHarness(d.site, overrides);
  if (d.artifact !== undefined) {
    const store = new FileCandidateStore<CandidateFiles, ReturnType<typeof CandidateDecision.parse>>(
      {
        files: { "runs.json": CandidateRuns, "candidate.json": ArtifactSchema, "issues.json": CandidateIssues },
        decision: CandidateDecision,
      },
      { dir: join(root, "artifacts"), artifactsDir: join(root, "artifacts"), tmpDir: join(root, "tmp") },
      new SteppingClock(),
    );
    await store.seal("kvfcu/sign_in/cand_2026-01-15_1000000001", "1.0.0", "op_017", SIGN_IN, {});
    await store.seal("kvfcu/open_sub/cand_2026-01-15_1000000002", "1.0.0", "op_017", d.artifact, {});
    await store.seal("kvfcu/check_sub/cand_2026-01-15_1000000003", "1.0.0", "op_017", CHECK_SUB, {});
    h.deps.artifacts = store;
  }
  const input = replayInputOf(h, requestOf(d.authorized ? { authorization: authorizationFor("kvfcu/open_sub@1") } : {}));
  const running = runReplay(input, h.deps);
  await vi.waitFor(() => {
    expect(operator.requests.length).toBe(d.waitRequests);
  });
  d.play(surface);
  const read = async (): Promise<Line[]> => {
    const ev = await evidence.events(TENANT, input.runId);
    return ev.ok ? (ev.value as Line[]) : [];
  };
  if (d.until !== undefined) {
    await d.until(read);
    abort.abort();
  }
  const { runId, result } = await running;
  const lines = await read();
  const files = await readTree(join(root, "evidence", TENANT, "runs", runId));
  return { operator, result, lines, files };
}

const actions = (lines: Line[]): Line[] => lines.filter((l) => l.event === "action" && l.by === "human");
const checkLines = (lines: Line[]): Line[] => lines.filter((l) => l.event === "check" && l.data["role"] === "watch");

const PASSWORD: FakeElement = {
  id: "pw",
  role: "textbox",
  roleGroup: "text_entry",
  label: "Password",
  field: { kind: "password", value: "" },
};

/** The fixture site, with a password box on the home page. */
function siteWithPassword(): FakeSite {
  const site = fixtureSite();
  const home = site.screens["/home"];
  if (home === undefined) throw new Error("no /home");
  return { ...site, screens: { ...site.screens, "/home": { ...home, elements: [...home.elements, PASSWORD] } } };
}

describe("typed text (section 7 §14.2, section 4 §8.10)", () => {
  test("a person's typing is logged [human_text], [secret], or {input.x}; the raw text is in no file of the run", async () => {
    const { lines, files } = await drive({
      site: siteWithPassword(),
      answers: ["silent", { staff: "op_017", decision: "end_run" }],
      authorized: true,
      waitRequests: 1,
      play: (s) => {
        s.humanInput({ type: "type", element: "member_id_box", value: SECRET_TEXT });
        s.humanInput({ type: "type", element: "pw", value: SECRET_TEXT });
        s.humanInput({ type: "type", element: "member_id_box", value: MEMBER_FOUND });
      },
    });

    const typed = actions(lines).filter((l) => l.data["type"] === "type");
    expect(typed.map((l) => l.data["value"])).toEqual(["[human_text]", "[secret]", "{input.member_id}"]);
    expect(typed.every((l) => l.by === "human")).toBe(true);
    // The real safety assertion: the typed text is in no byte of any file the run left.
    expect(files.length).toBeGreaterThan(3);
    expect(files.some((f) => f.path === "events.jsonl" || f.path.endsWith(".jsonl"))).toBe(true);
    for (const f of files) {
      expect(Buffer.from(f.bytes).includes(SECRET_TEXT), `${f.path} holds the typed text`).toBe(false);
    }
  });

  test("every human input is also a gate line: observed, human.observed", async () => {
    const { lines } = await drive({
      site: fixtureSite(),
      answers: ["silent", { staff: "op_017", decision: "end_run" }],
      authorized: true,
      waitRequests: 1,
      play: (s) => {
        s.humanInput({ type: "type", element: "member_id_box", value: SECRET_TEXT });
      },
    });
    const gate = lines.filter((l) => l.event === "gate" && l.data["actor"] === "human");
    expect(gate).toHaveLength(1);
    expect(gate[0]?.data).toMatchObject({ decision: "observed", action: "type" });
  });
});

describe("a person sends the commit (section 7 §14.4)", () => {
  // Confirm only inserts a banner, so the checkpoint never shows and the watcher never settles it.
  const stuckSite = (): FakeSite => {
    const site = fixtureSite({ confirm: "stuck" });
    return site;
  };

  test("a click on Confirm while the commit is not_sent: uncertain, performed_by human, a warning, the notice", async () => {
    const checks = { calls: 0 };
    const { operator, result, lines } = await drive({
      site: stuckSite(),
      // Start approved; then the commit approval waits; then the takeover (both silent).
      answers: [START, "silent", "silent"],
      authorized: false,
      waitRequests: 2,
      play: (s) => {
        s.humanInput({ type: "click", element: "confirm_button" });
      },
      until: async (read) => {
        await vi.waitFor(async () => {
          expect((await read()).some((l) => l.event === "escalation" && l.data["kind"] === "takeover" && l.data["state"] === "open")).toBe(true);
        });
      },
      checks,
    });

    expect(operator.requests[1]).toMatchObject({ kind: "approval" });
    expect(operator.closed[1]).toBe("run_ended");
    expect(operator.requests[2]).toMatchObject({
      kind: "takeover",
      reason: "unexpected_human_input",
      commit: { state: "uncertain", notice: "The commit action was already sent. Do not submit again." },
    });
    const warning = lines.find((l) => l.event === "warning" && l.data["code"] === "human_irreversible_action");
    expect(warning).toBeDefined();
    expect(actions(lines)[0]?.data).toMatchObject({ type: "click" });
    // The bot never sent it: no commit_intent line.
    expect(lines.map((l) => l.event)).not.toContain("commit_intent");
    // The run ends with the check for an in-flight commit, and the person as performer.
    expect(checks.calls).toBe(1);
    expect(result.effect).toMatchObject({ performed_by: "human" });
    expect(result.effect?.sent_at).toBeTruthy();
  });

  test("another key while the commit is not_sent changes no commit state", async () => {
    const { operator, result } = await drive({
      site: stuckSite(),
      answers: [START, "silent", { staff: "op_017", decision: "end_run" }],
      authorized: false,
      waitRequests: 2,
      play: (s) => {
        s.humanInput({ type: "press", key: "Tab" });
      },
    });
    expect(operator.requests[2]).toMatchObject({ kind: "takeover", commit: { state: "not_sent" } });
    expect(result.effect).toMatchObject({ commit: "not_sent" });
  });
});

describe("the watcher while a person drives (section 7 §15)", () => {
  /** Plays the person: click Confirm, so the commit is in flight and the page moves on. */
  const playConfirm = (s: SnapshotSurface): void => {
    s.humanInput({ type: "click", element: "confirm_button" });
  };
  const sawWatch = (read: () => Promise<Line[]>, passed: string) => async (): Promise<void> => {
    await vi.waitFor(async () => {
      const found = checkLines(await read()).some((l) => l.data["condition"] === passed && l.data["passed"] === true);
      expect(found).toBe(true);
    });
  };

  test("a passing checkpoint: a check line role watch, and the commit becomes confirmed (no reconciliation check)", async () => {
    const checks = { calls: 0 };
    const { result, lines } = await drive({
      site: fixtureSite(),
      answers: [START, "silent", "silent"],
      authorized: false,
      waitRequests: 2,
      play: playConfirm,
      until: (read) => sawWatch(read, "done_shown")(),
      checks,
    });
    expect(checkLines(lines).find((l) => l.data["condition"] === "done_shown")).toMatchObject({
      by: "engine",
      step: "click_confirm",
      data: { role: "watch", passed: true },
    });
    expect(result.effect).toMatchObject({ commit: "confirmed", performed_by: "human" });
    expect(checks.calls).toBe(0);
  });

  test("a declared outcome shows: the commit becomes refused", async () => {
    const site = fixtureSite();
    const result = site.screens["/result"];
    if (result === undefined) throw new Error("no /result");
    // Confirm goes to a screen that shows the declared outcome's text, and not the done page.
    const moved: FakeSite = {
      ...site,
      screens: {
        ...site.screens,
        "/result": { ...result, elements: [{ ...(result.elements[0] as FakeElement), onClick: { go: "/check" } }] },
        "/check": { elements: [{ id: "nf", role: "generic", roleGroup: "container", text: "No member found" }] },
      },
    };
    const checks = { calls: 0 };
    const run = await drive({
      site: moved,
      answers: [START, "silent", "silent"],
      authorized: false,
      waitRequests: 2,
      play: playConfirm,
      until: (read) => sawWatch(read, "not_found_text")(),
      artifact: COMMIT_DECLARES,
      checks,
    });
    expect(run.result.effect).toMatchObject({ commit: "refused" });
    expect(checks.calls).toBe(0);
    expect(checkLines(run.lines).some((l) => l.data["condition"] === "done_shown" && l.data["passed"] === true)).toBe(false);
  });

  test("a declared outcome wins over the checkpoint when both show", async () => {
    const site = fixtureSite();
    const done = site.screens["/done"];
    if (done === undefined) throw new Error("no /done");
    const both: FakeSite = {
      ...site,
      screens: {
        ...site.screens,
        "/done": { ...done, elements: [...done.elements, { id: "nf", role: "generic", roleGroup: "container", text: "No member found" }] },
      },
    };
    const run = await drive({
      site: both,
      answers: [START, "silent", "silent"],
      authorized: false,
      waitRequests: 2,
      play: playConfirm,
      until: (read) => sawWatch(read, "not_found_text")(),
      artifact: COMMIT_DECLARES,
    });
    expect(run.result.effect).toMatchObject({ commit: "refused" });
  });

  test("the watcher is quiet while the commit is not in flight: no check lines", async () => {
    const { lines } = await drive({
      site: fixtureSite(),
      answers: [START, "silent", { staff: "op_017", decision: "end_run" }],
      authorized: false,
      waitRequests: 2,
      // A person presses Tab, not Confirm: the commit stays not_sent.
      play: (s) => {
        s.humanInput({ type: "press", key: "Tab" });
      },
    });
    expect(checkLines(lines)).toEqual([]);
  });
});
