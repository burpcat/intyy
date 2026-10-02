// Proves `intyy run status | list | show`. Design section 9 §10.2 (waiting, polling, the
// delivery window); section 3 §5.13 (a re-read after the delivery window is masked, with
// warning `outputs_masked`). M05 task 9.
import { afterAll, describe, expect, test } from "vitest";
import { cleanRoots } from "./helpers.js";
import {
  MEMBER_FOUND,
  replayCall,
  replayRoot,
  runSupervisedToEnd,
  startCall,
  waitForMailboxOpen,
  waitForPrompt,
  writeAuthorization,
  writeInputs,
  type ReplayEnv,
} from "./replay-harness.js";

afterAll(cleanRoots);

function openSubArgv(env: ReplayEnv): string[] {
  const inputs = writeInputs(env, { member_id: MEMBER_FOUND });
  const auth = writeAuthorization(env, "kvfcu/open_sub@1");
  return ["replay", "kvfcu/open_sub@1", "--mode", "supervised", "--inputs", inputs, "--authorization", auth, "--json"];
}

describe("intyy run status: not final (section 9 §10.2)", () => {
  test("a paused run reads escalated, exit 3 — verified against S9's own table", async () => {
    const env = await replayRoot();
    const started = startCall(env, openSubArgv(env));
    const runId = await waitForPrompt(started);
    await waitForMailboxOpen(env, runId);

    const status = await replayCall(env, ["run", "status", runId, "--json"]);
    expect(status.code).toBe(3);
    const data = JSON.parse(status.stdout) as { status: string };
    expect(data.status).toBe("escalated");

    // Let the paused run finish, so its own temp root is quiet before cleanup.
    let decided = await replayCall(env, ["operator", "decide", runId, "approved"]);
    const start = Date.now();
    while (decided.code !== 0 && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      decided = await replayCall(env, ["operator", "decide", runId, "approved"]);
    }
    await started.code;
  });
});

describe("intyy run status | show | list: a final run (section 3 §5.13)", () => {
  test("status re-reads run.json masked to the literal [financial], with warning outputs_masked; show prints the same masked result; list shows the run in one document", async () => {
    const env = await replayRoot();
    const ran = await runSupervisedToEnd(env, openSubArgv(env));
    expect(ran.code).toBe(0);

    const status = await replayCall(env, ["run", "status", ran.runId, "--json"]);
    expect(status.code).toBe(0);
    const data = JSON.parse(status.stdout) as {
      status: string;
      outputs?: Record<string, unknown>;
      warnings: { code: string }[];
    };
    expect(data.status).toBe("success");
    expect(data.warnings.some((w) => w.code === "outputs_masked")).toBe(true);
    // A re-read never shows the raw value: a live delivery already happened once.
    // open_sub.json's account_number output is declared `sensitivity: "financial"`.
    expect(data.outputs?.account_number).toBe("[financial]");

    // show prints the same stored result, masked the same way
    const shown = await replayCall(env, ["run", "show", ran.runId, "--json"]);
    expect(shown.code).toBe(0);
    const shownData = JSON.parse(shown.stdout) as { status: string; outputs?: Record<string, unknown> };
    expect(shownData.status).toBe("success");
    expect(shownData.outputs?.account_number).toBe("[financial]");

    // list shows the run, and --json prints exactly one document
    const listed = await replayCall(env, ["run", "list", "--json"]);
    expect(listed.code).toBe(0);
    // Exactly one JSON document: parsing the whole of stdout succeeds, with nothing left over.
    const listData = JSON.parse(listed.stdout) as { runs: { run_id: string; status: string }[] };
    expect(listData.runs.some((r) => r.run_id === ran.runId && r.status === "success")).toBe(true);
  });
});
