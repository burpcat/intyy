// Proves human input stops a replay and opens a takeover, through `runReplay`: during the start
// confirmation and during a commit approval, with the lease lines and the warning logged and no
// commit sent. Also proves a discovery run logs `lease` run_start and run_end lines.
// Design section 7 §12.2 to §12.4 ("the approval closes unanswered; it becomes a takeover");
// docs/decisions.md, M07 (agent defaults). M07 task 1.
import { describe, expect, test, vi } from "vitest";
import { runReplay } from "../../../src/core/replay/executor.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { FakeOperator } from "../../../src/fakes/operator.js";
import { SnapshotSurface } from "../../../src/fakes/snapshot-surface/index.js";
import { toFactory } from "../../../src/ports/hands.js";
import { names, run } from "../discovery/run-kit.js";
import { authorizationFor, buildHarness, fixtureSite, replayInputOf, requestOf } from "../replay/executor-harness.js";

/** A stepping clock whose long waits (an operator deadline, one minute or more) never end on
 * their own, only when aborted. The fake operator's `silent` request would otherwise time out
 * at once, since `SteppingClock` resolves every wait. */
class HoldingClock extends SteppingClock {
  override after(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms < 60_000) return super.after(ms, signal);
    return new Promise((_resolve, reject) => {
      if (signal?.aborted === true) reject(signal.reason as Error);
      signal?.addEventListener(
        "abort",
        () => {
          reject(signal.reason as Error);
        },
        { once: true },
      );
    });
  }
}

type Line = { seq: number; event: string; step: string | null; by: string; data: Record<string, unknown> };

/** Runs a replay on the fixture site, touches the page once `waitFor` requests are open, and
 * returns what the run left. */
async function runTouched(opts: { answers: ConstructorParameters<typeof FakeOperator>[0]; waitFor: number; authorized: boolean }) {
  const operator = new FakeOperator(opts.answers);
  const surface = new SnapshotSurface(fixtureSite());
  const h = await buildHarness(fixtureSite(), {
    clock: new HoldingClock(),
    surface: toFactory(surface),
    operator: () => operator,
  });
  const input = replayInputOf(
    h,
    requestOf(opts.authorized ? { authorization: authorizationFor("kvfcu/open_sub@1") } : {}),
  );
  const running = runReplay(input, h.deps);
  await vi.waitFor(() => {
    expect(operator.requests.length).toBe(opts.waitFor);
  });
  surface.humanInput();
  const { runId, result } = await running;
  const events = await h.deps.evidence.events(input.tenant, runId);
  if (!events.ok) throw new Error("events failed");
  return { operator, result, lines: events.value as Line[] };
}

const leaseReasons = (lines: Line[]): unknown[] =>
  lines.filter((l) => l.event === "lease").map((l) => l.data["reason"]);

describe("human input during the start confirmation (section 7 §12.4)", () => {
  test("the confirmation closes run_ended, and a takeover opens with reason unexpected_human_input", async () => {
    const { operator, result, lines } = await runTouched({
      answers: ["silent", { staff: "op_017", decision: "end_run" }],
      waitFor: 1,
      authorized: true,
    });

    expect(operator.requests[0]?.kind).toBe("start_confirmation");
    expect(operator.closed[0]).toBe("run_ended");
    expect(operator.requests).toHaveLength(2);
    expect(operator.requests[1]).toMatchObject({ kind: "takeover", reason: "unexpected_human_input" });
    expect(result.status).toBe("failed");

    const warning = lines.find((l) => l.event === "warning");
    expect(warning?.data["code"]).toBe("human_input_while_bot");

    expect(leaseReasons(lines)).toEqual(["run_start", "awaiting_decision", "takeover_requested", "run_end"]);
    // No claim and no handback happened, so every change is the engine's.
    expect(lines.filter((l) => l.event === "lease").every((l) => l.by === "engine")).toBe(true);
  });

  test("the bot sends no action and no commit after the human touched the page", async () => {
    const { lines } = await runTouched({
      answers: ["silent", { staff: "op_017", decision: "end_run" }],
      waitFor: 1,
      authorized: true,
    });
    const warnAt = lines.findIndex((l) => l.event === "warning");
    expect(warnAt).toBeGreaterThan(-1);
    const after = lines.slice(warnAt).map((l) => l.event);
    expect(after).not.toContain("action");
    expect(after).not.toContain("gate");
    expect(after).not.toContain("commit_intent");
    expect(lines.map((l) => l.event)).not.toContain("commit_intent");
  });
});

describe("human input during a commit approval (section 7 §12.4)", () => {
  test("the approval closes run_ended, the takeover follows it, and no commit_intent is written", async () => {
    // Request 0 is the start confirmation (approved). Request 1 is the commit approval (silent).
    const { operator, result, lines } = await runTouched({
      answers: [{ staff: "op_017", decision: "approved" }, "silent", { staff: "op_017", decision: "end_run" }],
      waitFor: 2,
      authorized: false,
    });

    expect(operator.requests[0]?.kind).toBe("start_confirmation");
    expect(operator.requests[1]).toMatchObject({ kind: "approval", reason: "no_authorization" });
    expect(operator.closed[0]).toBe("resolved");
    expect(operator.closed[1]).toBe("run_ended");
    expect(operator.requests[2]).toMatchObject({ kind: "takeover", reason: "unexpected_human_input" });
    expect(result.status).toBe("failed");

    expect(lines.map((l) => l.event)).not.toContain("commit_intent");
    expect(lines.find((l) => l.event === "warning")?.data["code"]).toBe("human_input_while_bot");
    const reasons = leaseReasons(lines);
    expect(reasons).toEqual([
      "run_start",
      "awaiting_decision",
      "decided",
      "awaiting_decision",
      "takeover_requested",
      "run_end",
    ]);
  });
});

describe("discovery's lease (docs/decisions.md, M07)", () => {
  test("a run's log holds a lease run_start line first and a run_end line last", async () => {
    const ran = await run({});
    try {
      expect(ran.result.status).toBe("success");
      const leases = ran.events.filter((e) => e["event"] === "lease");
      const data = leases.map((e) => e["data"]);
      expect(data[0]).toMatchObject({ from: "nobody", to: "bot", reason: "run_start", staff_id: null, implicit: false });
      expect(data.at(-1)).toMatchObject({ from: "bot", to: "nobody", reason: "run_end" });
      expect(data.filter((d) => (d as { reason: string }).reason === "run_end")).toHaveLength(1);
      const order = names(ran.events);
      expect(order.indexOf("lease")).toBeLessThan(order.indexOf("run_end"));
    } finally {
      await ran.remove();
    }
  });
});
