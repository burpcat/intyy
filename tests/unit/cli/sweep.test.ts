// Proves the crash sweep at the CLI: every command sweeps first (design section 9 §7.8),
// `run sweep` lists what it closed with commit states and the `reconcile` command for an
// uncertain one (section 9 §10.7), and `--force-unlock` removes a lock. M05 task 10.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { Masked } from "../../../src/ports/masked.js";
import { cleanRoots } from "./helpers.js";
import { replayCall, replayRoot, realWiringOf, stubSweep, type ReplayEnv } from "./replay-harness.js";

afterAll(cleanRoots);

function maskedCast<T>(v: T): Masked<T> {
  return v as Masked<T>;
}

/** One `events.jsonl` line, hand-built (the sweep reads only seq/at/step/event/data). */
function line(seq: number, at: string, step: string | null, event: string, data: unknown): unknown {
  return { seq, at, run_id: "unused", step, by: "engine", event, data };
}

/** Writes a crash candidate straight onto disk, through the real evidence store: a run folder
 * with `events`, and a tenant-index line naming it `running`, but never a `run.json` and never
 * a held "run" lock (docs/decisions.md, M05). */
async function seedCrashedRun(
  env: ReplayEnv,
  runId: string,
  opts: { kind: "discovery" | "replay"; capability: string; events: unknown[] },
): Promise<void> {
  const wiring = realWiringOf(env);
  const created = await wiring.evidence.createRun("keystone", runId);
  if (!created.ok) throw new Error("test setup: createRun failed");
  for (const e of opts.events) await created.value.appendEvent(maskedCast(e));
  await wiring.evidence.appendIndex(
    "keystone",
    maskedCast({
      run_id: runId,
      at: "2026-01-15T09:00:00.000Z",
      status: "running",
      code: null,
      kind: opts.kind,
      capability: opts.capability,
    }),
  );
}

describe("the sweep at the CLI", () => {
  test("run list closes a crashed run first and prints the sweep line; run sweep lists each closed run's commit state and the reconcile command", async () => {
    const env = await replayRoot();
    await seedCrashedRun(env, "run_2026-01-15_2000000001", {
      kind: "discovery",
      capability: "kvfcu/sign_in",
      events: [line(1, "2026-01-15T09:00:00.000Z", null, "run_start", {})],
    });

    // every command sweeps first (section 9 §7.8)
    const got = await replayCall(env, ["run", "list"]);
    expect(got.code).toBe(0);
    expect(got.stderr).toContain("Closed 1 crashed run");
    expect(got.stderr).toContain("intyy run sweep");
    // A second command finds nothing left to close: the sweep already ran.
    const again = await replayCall(env, ["run", "list"]);
    expect(again.stderr).not.toContain("Closed");

    // intyy run sweep (section 9 §10.7): lists each closed run's commit state, and the reconcile command for an uncertain one
    await seedCrashedRun(env, "run_2026-01-15_2000000002", {
      kind: "replay",
      capability: "kvfcu/open_sub",
      events: [
        line(1, "2026-01-15T09:00:00.000Z", null, "run_start", {
          frozen: { artifact: { id: "kvfcu/open_sub@1.0.0", hash: `sha256:${"a".repeat(64)}` } },
          request_id: "run_2026-01-15_2000000002",
        }),
        line(2, "2026-01-15T09:00:01.000Z", "click_confirm", "commit_intent", {}),
      ],
    });

    const swept = await replayCall(env, ["run", "sweep"]);
    expect(swept.code).toBe(0);
    expect(swept.stdout).toContain("run_2026-01-15_2000000002");
    expect(swept.stdout).toContain("commit uncertain");
    expect(swept.stdout).toContain("intyy reconcile run_2026-01-15_2000000002 --inputs <file>");

    // The command's own sweep lists the run, clear of the program hook's own sweep.
    // Every command sweeps first, through the very same program hook (section 9 §7.8) —
    // including `run sweep` itself. In a real, single invocation, that hook's own sweep
    // already closes every crash candidate before `run sweep`'s own body ever runs a second
    // sweep, so the detailed listing above depends on the hook leaving something behind.
    // `stubSweep` here isolates `run sweep`'s own body, to show its own reporting is correct.
    await seedCrashedRun(env, "run_2026-01-15_2000000009", {
      kind: "replay",
      capability: "kvfcu/open_sub",
      events: [
        line(1, "2026-01-15T09:00:00.000Z", null, "run_start", {
          frozen: { artifact: { id: "kvfcu/open_sub@1.0.0", hash: `sha256:${"a".repeat(64)}` } },
          request_id: "run_2026-01-15_2000000009",
        }),
        line(2, "2026-01-15T09:00:01.000Z", "click_confirm", "commit_intent", {}),
      ],
    });

    const stubbed = await replayCall(env, ["run", "sweep"], { sweep: stubSweep });
    expect(stubbed.code).toBe(0);
    expect(stubbed.stdout).toContain("run_2026-01-15_2000000009");
    expect(stubbed.stdout).toContain("commit uncertain");
    expect(stubbed.stdout).toContain("intyy reconcile run_2026-01-15_2000000009 --inputs <file>");
  });

  test("--force-unlock needs a reason on standard input, then releases a lock this process did not take", async () => {
    const env = await replayRoot();
    const lockDir = join(env.root, "state", "var", "locks", "runs");
    mkdirSync(lockDir, { recursive: true });
    const lockOf = (runId: string) =>
      JSON.stringify({
        schema: "intyy.lock/1.0",
        owner: runId,
        pid: 999_999,
        host: "another-machine",
        command: "replay",
        staff: null,
        started_at: "2026-01-15T09:00:00.000Z",
      });

    // --force-unlock without a reason on standard input is a usage error
    const noReason = "run_2026-01-15_2000000004";
    writeFileSync(join(lockDir, `${noReason}.lock`), lockOf(noReason));
    const refused = await replayCall(env, ["run", "sweep", "--force-unlock", `run:${noReason}`]);
    expect(refused.code).toBe(1);

    // --force-unlock releases a lock this process did not take, and needs the operator role
    const runId = "run_2026-01-15_2000000003";
    writeFileSync(join(lockDir, `${runId}.lock`), lockOf(runId));

    const wiring = realWiringOf(env);
    const before = await wiring.locks.inspect("run", runId);
    expect(before).not.toBeNull();

    const got = await replayCall(env, ["run", "sweep", "--force-unlock", `run:${runId}`], {
      stdin: "the other machine is gone",
    });
    expect(got.code).toBe(0);
    expect(got.stderr).toContain("force-unlocked");

    const after = await wiring.locks.inspect("run", runId);
    expect(after).toBeNull();
  });
});
