// The demo path on the live bank app (design section 9 §13.2 steps 4 and 5; section 7 §10, the
// prelude in replay; section 7 §18, determinism). `kvfcu/open_share_subaccount` is not sealed
// yet (the owner's M05 steps run after this task): every test here fails loudly, with a clear
// message, until it is. Never skip, and never expect `capability_not_found`. M05 task 13.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { exitForStatus } from "../../src/cli/exit-codes.js";
import type { LockHold } from "../../src/ports/locks.js";
import { acquireInstanceLock, demoFile, locks, requireSealedDemoArtifact, runOpenSub } from "./replay-demo-kit.js";

let hold: LockHold | null = null;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  await requireSealedDemoArtifact();
  hold = await acquireInstanceLock("test:live replay-demo");
});

afterAll(async () => {
  for (const c of cleanups.splice(0)) await c();
  if (hold !== null) await locks.release(hold);
});

/** Projects one log line for the determinism compare (section 7 §18): the event kind, the step,
 * the winning target (already baked into `data.target` by clue voting), and the action type.
 * Drops `at`, `run_id`, `seq`, hashes, and every other timing or identity field. */
function projected(events: readonly Record<string, unknown>[]): unknown[] {
  return events.map((e) => {
    const data = (e.data ?? {}) as Record<string, unknown>;
    return {
      event: e.event,
      step: e.step ?? null,
      target: typeof data.target === "string" ? data.target : null,
      actionType: typeof data.type === "string" ? data.type : null,
    };
  });
}

describe("the demo path: steps 4 and 5 (section 9 §13.2)", () => {
  test("the prelude signs in, then the task starts, then success with the account number", async () => {
    const { outcome, events, remove } = await runOpenSub(demoFile("valid.json"));
    cleanups.push(remove);
    expect(outcome.result.status).toBe("success");
    if (outcome.result.status !== "success") throw new Error("expected success");
    expect(outcome.result.outputs.account_number).toBeTruthy();

    // The prelude's own steps, then the task's navigate to its entry, then the task's own
    // steps: exactly the order section 7 §10 lays out. Why the entry is optional: the engine
    // skips that navigate when sign-in already lands on the entry (kvfcu lands on /main.do).
    const gateSteps = events.filter((e) => e.event === "gate").map((e) => e.step as string | null);
    const firstSession = gateSteps.findIndex((s) => s?.startsWith("session:") === true);
    const lastSession = gateSteps.findLastIndex((s) => s?.startsWith("session:") === true);
    const entryAt = gateSteps.indexOf("entry");
    expect(firstSession).toBeGreaterThanOrEqual(0);
    const firstTaskStep = gateSteps.findIndex(
      (s, i) => i > lastSession && s !== null && s !== "entry" && !s.startsWith("session:"),
    );
    expect(firstTaskStep).toBeGreaterThan(lastSession);
    if (entryAt >= 0) {
      expect(entryAt).toBeGreaterThan(lastSession);
      expect(entryAt).toBeLessThan(firstTaskStep);
    }
  });

  test("demo/missing.json: business_outcome member_not_found, exit 2", async () => {
    const { outcome, remove } = await runOpenSub(demoFile("missing.json"));
    cleanups.push(remove);
    expect(outcome.result.status).toBe("business_outcome");
    if (outcome.result.status !== "business_outcome") throw new Error("expected business_outcome");
    expect(outcome.result.outcome.code).toBe("member_not_found");
    expect(exitForStatus(outcome.result.status)).toBe(2);
  });
});

describe("determinism (section 7 §18)", () => {
  test("two replays of demo/missing.json give the same step trace", async () => {
    // Why missing.json: no commit, safe to repeat (section 7 §18's own determinism test).
    const first = await runOpenSub(demoFile("missing.json"));
    cleanups.push(first.remove);
    const second = await runOpenSub(demoFile("missing.json"));
    cleanups.push(second.remove);
    expect(projected(second.events)).toEqual(projected(first.events));
  });
});
