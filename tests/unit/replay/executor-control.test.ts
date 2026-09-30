// Proves the executor's determinism (design section 7 §18: "same frozen facts, same inputs,
// same app state, same fault seed: same step trace") and Ctrl-C (docs/decisions.md, M05: the
// first Ctrl-C stops at the next step boundary or wait, never between `commit_intent` and the
// commit step's own end). M05 task 8.
import { describe, expect, test } from "vitest";
import { runReplay } from "../../../src/core/replay/executor.js";
import type { Clock } from "../../../src/ports/clock.js";
import type { Masked } from "../../../src/ports/masked.js";
import type { EvidenceStore, RunFolder } from "../../../src/ports/stores.js";
import {
  TENANT,
  authorizationFor,
  buildHarness,
  fixtureSite,
  replayInputOf,
  requestOf,
} from "./executor-harness.js";

const OPEN_SUB_AUTH = authorizationFor("kvfcu/open_sub@1");

/** One event line, with only its volatile fields named: `at` (a time) and `run_id` (this run's
 * own identity). Neither is part of "the part of the log that must be identical across repeat
 * runs" (section 3 §6.8: "Excludes: times, durations, wait lengths, scores, and file paths"). */
function stepTrace(events: readonly unknown[]): unknown[] {
  return events.map((e) =>
    Object.fromEntries(Object.entries(e as Record<string, unknown>).filter(([k]) => k !== "at" && k !== "run_id")),
  );
}

describe("runReplay: determinism (section 7 §18)", () => {
  test("two runs of the same request give the same step trace", async () => {
    const req = requestOf({ authorization: OPEN_SUB_AUTH });
    const h1 = await buildHarness(fixtureSite());
    const h2 = await buildHarness(fixtureSite());

    const r1 = await runReplay(replayInputOf(h1, req), h1.deps);
    const r2 = await runReplay(replayInputOf(h2, req), h2.deps);
    expect(r1.result.status).toBe("success");
    expect(r2.result.status).toBe("success");

    const e1 = await h1.deps.evidence.events(TENANT, r1.runId);
    const e2 = await h2.deps.evidence.events(TENANT, r2.runId);
    if (!e1.ok || !e2.ok) throw new Error("events failed");
    expect(stepTrace(e1.value)).toEqual(stepTrace(e2.value));
  });
});

describe("runReplay: Ctrl-C (docs/decisions.md, M05)", () => {
  test("an abort seen between steps ends failed, ended_by_operator, with nothing committed", async () => {
    const h = await buildHarness(fixtureSite());
    const controller = new AbortController();
    // Aborted before the run even starts: the fixture site settles every wait on its first
    // look (no real polling), so this is caught only at the steps loop's own check, right
    // after the prelude and the task's entry navigation both already ran.
    controller.abort();
    const input = replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH }));

    const { result } = await runReplay(input, { ...h.deps, signal: controller.signal });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error(`expected failed, got ${result.status}`);
    expect(result.failure.code).toBe("ended_by_operator");
    // Nothing was committed: the commit step's own branch never ran.
    expect(result.effect).toMatchObject({ commit: "not_sent", performed_by: null, sent_at: null });
  });

  test("an abort seen once the commit has started still lets the commit step finish", async () => {
    const h = await buildHarness(fixtureSite());
    const controller = new AbortController();
    const commitIntentSeen = { value: false };

    // Wraps the evidence store's run folder so `appendEvent` can see the `commit_intent` line
    // land (the write-ahead rule, section 3 §6.6): that is "the commit has started".
    function wrapFolder(folder: RunFolder): RunFolder {
      return {
        runId: folder.runId,
        appendEvent: (line: Masked<unknown>, opts, signal) => {
          if ((line as unknown as { event?: string }).event === "commit_intent") commitIntentSeen.value = true;
          return folder.appendEvent(line, opts, signal);
        },
        writeFile: (path, bytes, signal) => folder.writeFile(path, bytes, signal),
        writeRunJson: (run, signal) => folder.writeRunJson(run, signal),
        readFile: (path, signal) => folder.readFile(path, signal),
      };
    }
    const baseEvidence = h.deps.evidence;
    // Why not `{ ...baseEvidence }`: a class instance's methods live on its prototype, not as
    // its own enumerable properties, so a spread would silently drop every one of them.
    const wrappedEvidence: EvidenceStore = {
      createRun: async (tenant, runId, signal) => {
        const created = await baseEvidence.createRun(tenant, runId, signal);
        return created.ok ? { ok: true, value: wrapFolder(created.value) } : created;
      },
      openRun: (tenant, runId, signal) => baseEvidence.openRun(tenant, runId, signal),
      readRunJson: (tenant, runId, signal) => baseEvidence.readRunJson(tenant, runId, signal),
      events: (tenant, runId, signal) => baseEvidence.events(tenant, runId, signal),
      appendIndex: (tenant, line, signal) => baseEvidence.appendIndex(tenant, line, signal),
      index: (tenant, signal) => baseEvidence.index(tenant, signal),
      listRuns: (tenant) => baseEvidence.listRuns(tenant),
    };

    // Aborts on the first clock read once `commit_intent` has landed: the very next read is
    // `commitStep`'s own `sentAt`, right after the click was sent (section 3 §6.6, step 2),
    // before its checkpoint race even starts.
    let aborted = false;
    const baseClock = h.deps.clock;
    const wrappedClock: Clock = {
      now: () => {
        const v = baseClock.now();
        if (commitIntentSeen.value && !aborted) {
          aborted = true;
          controller.abort();
        }
        return v;
      },
      after: (ms, signal) => baseClock.after(ms, signal),
    };

    const input = replayInputOf(h, requestOf({ authorization: OPEN_SUB_AUTH }));
    const { result } = await runReplay(input, {
      ...h.deps,
      evidence: wrappedEvidence,
      clock: wrappedClock,
      signal: controller.signal,
    });

    expect(commitIntentSeen.value).toBe(true);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error(`expected failed, got ${result.status}`);
    expect(result.failure.code).toBe("ended_by_operator");
    // `safe_to_retry: false` only follows a `confirmed` (or `uncertain`) effect
    // (`safeToRetryOf`): the commit step ran to completion despite the abort.
    expect(result.failure.safe_to_retry).toBe(false);
  });
});
