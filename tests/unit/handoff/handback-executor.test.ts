// Proves the handback through `runReplay`: a scripted person takes over, acts on the page, and
// hands back; reverify and forward search find the step to resume at; the lease returns to the bot
// with a new token that the gate accepts; the person's finished steps end `done_by_human`; and a
// sent commit is never sent twice. Design section 7 §16.1 to §16.4, §20 (the worked example),
// §21 ("Handoff"); section 5 §8.6; docs/decisions.md, M07. M07 tasks 4 and 5.
import { describe, expect, test, vi } from "vitest";
import { runReplay, type ReplayDeps } from "../../../src/core/replay/executor.js";
import { FakeOperator, type FakeAnswer } from "../../../src/fakes/operator.js";
import { SnapshotSurface, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { toFactory } from "../../../src/ports/hands.js";
import {
  ACCOUNT_NUMBER,
  MEMBER_FOUND,
  TENANT,
  authorizationFor,
  buildHarness,
  fixtureSite,
  replayInputOf,
  requestOf,
} from "../replay/executor-harness.js";
import { HoldingClock } from "./kit.js";

type Line = { event: string; step: string | null; by: string; data: Record<string, unknown> };

const STAFF = "op_017";
const CLAIM = { staff: STAFF, claimed: true } as const;
const RELEASE = { staff: STAFF, released: true } as const;

type Drive = {
  site: FakeSite;
  /** What the person does on the page, between the claim and the release. `read` gives the run's
   * log so far, for a person who waits until the watcher has seen something. */
  act: (s: SnapshotSurface, read: () => Promise<Line[]>) => void | Promise<void>;
  /** Answers after the first handback. Left out, the fake operator ends the run. */
  then?: FakeAnswer[];
  reconciliationCheck?: ReplayDeps["reconciliationCheck"];
};

/**
 * One replay. The first mailbox request (the start confirmation) stays silent; a bare person's
 * input then stops the bot before its first step, which opens the takeover. The script claims it,
 * lets the person act, and releases.
 */
async function drive(d: Drive) {
  const surface = new SnapshotSurface(d.site);
  let read: () => Promise<Line[]> = () => Promise.resolve([]);
  const operator = new FakeOperator([
    "silent",
    CLAIM,
    { act: () => d.act(surface, read) },
    RELEASE,
    ...(d.then ?? []),
  ]);
  const overrides: Partial<ReplayDeps> = {
    clock: new HoldingClock(),
    surface: toFactory(surface),
    operator: () => operator,
    ...(d.reconciliationCheck === undefined ? {} : { reconciliationCheck: d.reconciliationCheck }),
  };
  const h = await buildHarness(d.site, overrides);
  const input = replayInputOf(h, requestOf({ authorization: authorizationFor("kvfcu/open_sub@1") }));
  read = async () => {
    const ev = await h.deps.evidence.events(TENANT, input.runId);
    return ev.ok ? (ev.value as Line[]) : [];
  };
  const running = runReplay(input, h.deps);
  await vi.waitFor(() => {
    expect(operator.requests.length).toBe(1);
  });
  surface.humanInput();
  const { result } = await running;
  return { operator, result, lines: await read() };
}

const names = (lines: Line[], event: string): unknown[] =>
  lines.filter((l) => l.event === event).map((l) => l.data["reason"] ?? l.data["code"]);
const leaseReasons = (lines: Line[]): unknown[] => names(lines, "lease");
const warnings = (lines: Line[]): unknown[] => names(lines, "warning");
const stepEnds = (lines: Line[]): Line[] => lines.filter((l) => l.event === "step_end" && l.data["result"] === "done_by_human");
const humanActions = (lines: Line[]): Line[] => lines.filter((l) => l.event === "action" && l.by === "human");

/** The person types the member ID and clicks Search: two of the three steps before the commit. */
const typeAndSearch = (s: SnapshotSurface): void => {
  s.humanInput({ type: "type", element: "member_id_box", value: MEMBER_FOUND });
  s.humanInput({ type: "click", element: "search_button" });
};
const confirm = (s: SnapshotSurface): void => {
  s.humanInput({ type: "click", element: "confirm_button" });
};
/** Waits until the watcher has seen the commit's checkpoint pass (section 7 §15). */
const untilWatcherConfirms = (read: () => Promise<Line[]>): Promise<void> =>
  vi.waitFor(async () => {
    const seen = (await read()).some((l) => l.event === "check" && l.data["role"] === "watch" && l.data["passed"] === true);
    expect(seen).toBe(true);
  });

describe("the worked example: a person does the early steps and hands back (section 7 §20)", () => {
  test("A: the bot resumes at the commit step, runs it, and reads the output", async () => {
    const { operator, result, lines } = await drive({ site: fixtureSite(), act: typeAndSearch });

    // The bot sent the commit itself and read the account number.
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.outputs).toEqual({ account_number: ACCOUNT_NUMBER });
    expect(result.effect).toMatchObject({ commit: "confirmed", performed_by: "bot" });

    // One intervention, with the count of the person's actions and the step the bot resumed at.
    expect(operator.requests[1]).toMatchObject({ kind: "takeover", reason: "unexpected_human_input", lease: "nobody" });
    expect(result.interventions).toHaveLength(1);
    expect(result.interventions[0]).toMatchObject({
      kind: "takeover",
      reason: "unexpected_human_input",
      step: "type_member_id",
      staff_id: STAFF,
      decision: "handed_back",
      human_actions: 2,
      resumed_at_step: "click_confirm",
    });

    // The two steps the person finished end `done_by_human`.
    expect(stepEnds(lines).map((l) => l.step)).toEqual(["type_member_id", "click_search"]);

    // The lease: claimed, handed back, reverified, then the run ends. The bot never took it back
    // without `reverified` (section 7 §12.3).
    expect(leaseReasons(lines)).toEqual([
      "run_start",
      "awaiting_decision",
      "takeover_requested",
      "claimed",
      "handed_back",
      "reverified",
      "run_end",
    ]);
    const reverified = lines.findIndex((l) => l.event === "lease" && l.data["reason"] === "reverified");
    expect(lines[reverified]).toMatchObject({ data: { from: "nobody", to: "bot" } });

    // `commit_intent` comes after the bot got the lease back, and the gate allows its click with
    // the new token (a stale token would be blocked, section 7 §12.3).
    const intents = lines.flatMap((l, i) => (l.event === "commit_intent" ? [i] : []));
    expect(intents).toHaveLength(1);
    expect(intents[0]).toBeGreaterThan(reverified);
    const gates = lines.slice(reverified).filter((l) => l.event === "gate" && l.data["actor"] === "engine");
    expect(gates.some((l) => l.step === "click_confirm" && l.data["action"] === "click" && l.data["decision"] === "allowed")).toBe(true);
    expect(lines.some((l) => l.event === "gate" && l.data["decision"] === "blocked")).toBe(false);

    // The person's typed member ID is a known input, so its log line shows the reference.
    const typed = humanActions(lines).filter((l) => l.data["type"] === "type");
    expect(typed.map((l) => l.data["value"])).toEqual(["{input.member_id}"]);
    expect(humanActions(lines).map((l) => l.data["type"])).toEqual(["type", "click"]);
  });

  test("B: the person also clicks Confirm; the bot only reads the output", async () => {
    const { result, lines } = await drive({
      site: fixtureSite(),
      act: (s) => {
        typeAndSearch(s);
        confirm(s);
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.outputs).toEqual({ account_number: ACCOUNT_NUMBER });
    expect(result.effect).toMatchObject({ commit: "confirmed", performed_by: "human" });
    expect(result.interventions[0]).toMatchObject({ human_actions: 3, resumed_at_step: "read_account_number" });

    // Three steps are the person's, and the bot never sent the commit itself.
    expect(stepEnds(lines).map((l) => l.step)).toEqual(["type_member_id", "click_search", "click_confirm"]);
    expect(lines.map((l) => l.event)).not.toContain("commit_intent");
    expect(warnings(lines)).toContain("human_irreversible_action");
    expect(leaseReasons(lines)).toContain("reverified");
  });
});

describe("reverify failed (section 7 §16.4)", () => {
  test("C: no step qualifies: warning, lease stays nobody, a new takeover opens, and end_run ends the run", async () => {
    const { operator, result, lines } = await drive({
      site: fixtureSite(),
      // The person leaves for the done page without sending anything: the commit stays `not_sent`.
      act: (s) => {
        s.humanInput({ type: "navigate", to: "/done" });
      },
      then: [{ staff: STAFF, decision: "end_run" }],
    });

    expect(leaseReasons(lines)).toEqual([
      "run_start",
      "awaiting_decision",
      "takeover_requested",
      "claimed",
      "handed_back",
      "reverify_failed",
      // The lease is already `nobody`, so the second takeover adds no lease line.
      "run_end",
    ]);
    const opened = lines.filter((l) => l.event === "escalation" && l.data["kind"] === "takeover" && l.data["state"] === "open");
    expect(opened.map((l) => l.data["reason"])).toEqual(["unexpected_human_input", "stuck"]);
    expect(leaseReasons(lines)).not.toContain("reverified");
    expect(warnings(lines)).toContain("handback_check_failed");

    // The second takeover is a `stuck` one, with the fixed note. Three requests in all.
    expect(operator.requests).toHaveLength(3);
    expect(operator.requests[2]).toMatchObject({ kind: "takeover", reason: "stuck" });
    expect(JSON.stringify(operator.requests[2])).toContain("handback check failed.");

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failure.code).toBe("ended_by_operator");
    // The first takeover still counts, with no step to resume at.
    expect(result.interventions[0]).toMatchObject({ decision: "handed_back", resumed_at_step: null });
    expect(stepEnds(lines)).toEqual([]);
  });
});

// ---- A sent commit is never sent twice ----------------------------------------------------

/** Confirm does nothing: the commit's checkpoint never comes, and the Confirm button stays. */
const stuckConfirm = (): FakeSite => fixtureSite({ confirm: "stuck" });

describe("guard: a sent commit is not retried (CLAUDE.md, section 7 §16.1)", () => {
  test("D: the person clicked Confirm, the check cannot tell, and the screen still offers Confirm: the commit step never runs again", async () => {
    const checks = { calls: 0 };
    const { result, lines } = await drive({
      site: stuckConfirm(),
      act: (s) => {
        typeAndSearch(s);
        confirm(s);
      },
      // `absent`, then the run asks the operator about a retry: the script declines.
      then: [{ staff: STAFF, decision: "no_retry" }],
      reconciliationCheck: () => {
        checks.calls += 1;
        return Promise.resolve({ kind: "absent" });
      },
    });

    // The commit was in flight, so the check ran first (section 7 §16.1 step 2).
    expect(checks.calls).toBe(1);
    // `click_confirm` is the step the screen qualifies for, but it was sent: no resume there.
    expect(lines.filter((l) => l.event === "commit_intent")).toHaveLength(0);
    expect(leaseReasons(lines)).not.toContain("reverified");
    expect(result.interventions[0]).toMatchObject({ decision: "handed_back", resumed_at_step: null });
    expect(result.effect).toMatchObject({ performed_by: "human" });
    expect(result.effect?.commit).not.toBe("not_sent");
    // The run ends without a second takeover or any resumed step.
    expect(result.status).toBe("failed");
    expect(stepEnds(lines)).toEqual([]);
  });

  test("E: the commit was confirmed, then the person left the done page: past the outputs, so the check supplies them", async () => {
    const { result, lines } = await drive({
      site: fixtureSite(),
      act: async (s, read) => {
        typeAndSearch(s);
        confirm(s);
        // Let the watcher see the confirmation first: after the person leaves, nothing proves it.
        await untilWatcherConfirms(read);
        s.humanInput({ type: "navigate", to: "/check" });
      },
      reconciliationCheck: () => Promise.resolve({ kind: "found_outputs_unavailable" }),
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failure.code).toBe("outputs_unavailable");
    expect(result.effect).toMatchObject({ commit: "found_by_check", performed_by: "human" });
    expect(leaseReasons(lines)).not.toContain("reverified");
    expect(result.interventions[0]).toMatchObject({ decision: "handed_back", resumed_at_step: null });
    expect(lines.filter((l) => l.event === "commit_intent")).toHaveLength(0);
  });

  test("E2: past the outputs, and the check finds them: the run succeeds from the check's outputs", async () => {
    const { result } = await drive({
      site: fixtureSite(),
      act: async (s, read) => {
        typeAndSearch(s);
        confirm(s);
        await untilWatcherConfirms(read);
        s.humanInput({ type: "navigate", to: "/check" });
      },
      reconciliationCheck: () => Promise.resolve({ kind: "found", outputs: { account_number: ACCOUNT_NUMBER } }),
    });
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.outputs).toEqual({ account_number: ACCOUNT_NUMBER });
    expect(result.effect).toMatchObject({ commit: "found_by_check" });
  });

  test("G: the commit was confirmed, then the person went back to a page that offers Confirm: it is not sent again", async () => {
    const { result, lines } = await drive({
      site: fixtureSite(),
      act: async (s, read) => {
        typeAndSearch(s);
        confirm(s);
        await untilWatcherConfirms(read);
        // On `/result`, `click_confirm`'s precondition and the checkpoint before it both pass. Only
        // the sent-commit guard keeps it from being the resume step.
        s.humanInput({ type: "navigate", to: "/result" });
      },
      reconciliationCheck: () => Promise.resolve({ kind: "found", outputs: { account_number: ACCOUNT_NUMBER } }),
    });
    expect(lines.filter((l) => l.event === "commit_intent")).toHaveLength(0);
    expect(leaseReasons(lines)).not.toContain("reverified");
    expect(result.interventions[0]).toMatchObject({ resumed_at_step: null });
    expect(result.effect).toMatchObject({ performed_by: "human" });
  });
});
