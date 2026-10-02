// Proves `intyy replay`: exit codes against design section 9 §7.5's own table, usage refusals,
// `--reveal-outputs`, the start confirmation, and Ctrl-C. Design section 9 §10.1 to §10.3;
// section 4 §9.14 (reveal rules); docs/decisions.md, M05. M05 task 9.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { maskOutputsForDelivery } from "../../../src/cli/commands/replay.js";
import { commands } from "../../../src/cli/commands/index.js";
import type { Result } from "../../../src/core/model/result.js";
import { call, cleanRoots } from "./helpers.js";
import {
  ACCOUNT_NUMBER,
  MEMBER_FOUND,
  MEMBER_MISSING,
  fixtureSite,
  readEvents,
  readRunJson,
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

/** `intyy replay kvfcu/open_sub@1 --mode supervised --inputs <file> --authorization <file>
 * --json`, ready to run: both files already written under `env.root`. */
function openSubArgv(env: ReplayEnv, memberId: string = MEMBER_FOUND): string[] {
  const inputs = writeInputs(env, { member_id: memberId });
  const auth = writeAuthorization(env, "kvfcu/open_sub@1");
  return ["replay", "kvfcu/open_sub@1", "--mode", "supervised", "--inputs", inputs, "--authorization", auth, "--json"];
}

describe("intyy replay: exit codes end to end (design section 9 §7.5's own table)", () => {
  test("success: exit 0, with outputs; the default request ID is the run ID, unmangled; --reveal-outputs pipes raw output and the run log never holds it", async () => {
    const env = await replayRoot();
    // --reveal-outputs: unambiguous raw output, so this test checks only the exit code, the
    // outputs, and the request ID, never the separate masking question (its own tests below).
    const got = await runSupervisedToEnd(env, [...openSubArgv(env), "--reveal-outputs"]);
    expect(got.code).toBe(0);
    const data = JSON.parse(got.stdout) as Result;
    expect(data.status).toBe("success");
    if (data.status !== "success") throw new Error("expected success");
    expect(data.outputs.account_number).toBe(ACCOUNT_NUMBER);
    // docs/decisions.md, M05: the default request ID is this run's own ID (a run-style ID, no
    // ':'), and it survives on disk unmangled — the redactor keeps a run-style ID as a Fact.
    expect(data.request_id).toBe(data.run_id);
    expect(data.request_id).not.toContain(":");
    const runJson = readRunJson(env, got.runId) as { request_id: string };
    expect(runJson.request_id).toBe(data.run_id);

    // accepted on test + loopback: piped output is raw with the flag. The run log records
    // outputs_revealed: true, and never the raw value (section 4 §9.14).
    expect(JSON.stringify(runJson)).not.toContain(ACCOUNT_NUMBER);
    const frozen = (runJson as unknown as { frozen: { outputs_revealed: unknown } }).frozen;
    expect(frozen.outputs_revealed).toBe(true);
    const events = readEvents(env, got.runId);
    expect(JSON.stringify(events)).not.toContain(ACCOUNT_NUMBER);
  });

  test("business_outcome: exit 2", async () => {
    const env = await replayRoot();
    const got = await runSupervisedToEnd(env, openSubArgv(env, MEMBER_MISSING), "approved", {
      site: fixtureSite({ result: "not_found" }),
    });
    expect(got.code).toBe(2);
    const data = JSON.parse(got.stdout) as Result;
    expect(data.status).toBe("business_outcome");
    if (data.status !== "business_outcome") throw new Error("expected business_outcome");
    expect(data.outcome.code).toBe("member_not_found");
  });

  test("rejected: unattended mode is context_not_approved, and bad inputs are invalid_input, both exit 4", async () => {
    const env = await replayRoot();
    const inputs = writeInputs(env, { member_id: MEMBER_FOUND });
    const got = await replayCall(env, [
      "replay",
      "kvfcu/open_sub@1",
      "--mode",
      "unattended",
      "--inputs",
      inputs,
      "--json",
    ]);
    expect(got.code).toBe(4);
    const data = JSON.parse(got.stdout) as Result;
    expect(data.status).toBe("rejected");
    if (data.status !== "rejected") throw new Error("expected rejected");
    expect(data.rejection.errors[0]?.code).toBe("context_not_approved");

    const badInputs = writeInputs(env, {});
    const bad = await replayCall(env, [
      "replay",
      "kvfcu/open_sub@1",
      "--mode",
      "supervised",
      "--inputs",
      badInputs,
      "--json",
    ]);
    expect(bad.code).toBe(4);
    const badData = JSON.parse(bad.stdout) as Result;
    expect(badData.status).toBe("rejected");
    if (badData.status !== "rejected") throw new Error("expected rejected");
    expect(badData.rejection.errors.some((e) => e.code === "invalid_input")).toBe(true);
  });

  test("failed: exit 5; declined is ended_by_operator, and effect not_sent for a commits capability", async () => {
    const env = await replayRoot();
    const got = await runSupervisedToEnd(env, openSubArgv(env), "declined");
    expect(got.code).toBe(5);
    const data = JSON.parse(got.stdout) as Result;
    expect(data.status).toBe("failed");
    if (data.status !== "failed") throw new Error("expected failed");
    expect(data.failure.code).toBe("ended_by_operator");
    expect(data.effect).toMatchObject({ commit: "not_sent", performed_by: null, sent_at: null });
  });
});

describe("intyy replay: usage refusals (section 9 §10.1)", () => {
  test("--pin is refused until M10; --request cannot mix with --mode, --inputs, or a capability; an inline input value is refused", async () => {
    const env = await replayRoot();
    const pin = await replayCall(env, ["replay", "kvfcu/open_sub@1", "--pin", "some-key"]);
    expect(pin.code).toBe(1);

    const inputs = writeInputs(env, { member_id: MEMBER_FOUND });
    const requestFile = writeInputs(
      env,
      {
        schema: "intyy.request/1.0",
        request_id: null,
        capability: "kvfcu/open_sub@1",
        inputs: { member_id: MEMBER_FOUND },
        mode: "supervised",
      },
      "request.json",
    );
    const withCapability = await replayCall(env, ["replay", "kvfcu/open_sub@1", "--request", requestFile]);
    expect(withCapability.code).toBe(1);
    const withMode = await replayCall(env, ["replay", "--request", requestFile, "--mode", "supervised"]);
    expect(withMode.code).toBe(1);
    const withInputs = await replayCall(env, ["replay", "--request", requestFile, "--inputs", inputs]);
    expect(withInputs.code).toBe(1);

    // an input value on the command line is impossible: --inputs takes only a file path or -
    // The value itself, inline, is not a file path: readFileSync fails and the command refuses.
    const got = await replayCall(env, [
      "replay",
      "kvfcu/open_sub@1",
      "--mode",
      "supervised",
      "--inputs",
      JSON.stringify({ member_id: MEMBER_FOUND }),
    ]);
    expect(got.code).toBe(1);
    expect(got.stderr).toContain("--inputs");
  });
});

describe("intyy replay: --reveal-outputs (section 4 §9.14)", () => {
  test("refused when the origin is not loopback, and when settings say environment: production", async () => {
    for (const [label, opts] of [
      ["origin", { origin: "https://example.com:8080" }],
      ["production", { environment: "production" }],
    ] as const) {
      const env = await replayRoot(opts);
      const inputs = writeInputs(env, { member_id: MEMBER_FOUND });
      const got = await replayCall(env, [
        "replay",
        "kvfcu/open_sub@1",
        "--mode",
        "supervised",
        "--inputs",
        inputs,
        "--reveal-outputs",
      ]);
      expect(got.code, label).toBe(1);
      expect(got.stderr, label).toContain("--reveal-outputs");
    }
  });

  test("piped output without the flag is masked: the literal [financial], per the contract label", async () => {
    const env = await replayRoot();
    const got = await runSupervisedToEnd(env, openSubArgv(env));
    expect(got.code).toBe(0);
    const data = JSON.parse(got.stdout) as Result;
    if (data.status !== "success") throw new Error("expected success");
    // open_sub.json's account_number output is declared `sensitivity: "financial"`.
    expect(data.outputs.account_number).toBe("[financial]");
    expect(data.warnings.some((w) => w.code === "outputs_masked")).toBe(true);
    expect(got.stdout).not.toContain(ACCOUNT_NUMBER);
  });

  test("an interactive terminal shows raw outputs, flag or not", async () => {
    const env = await replayRoot();
    const got = await runSupervisedToEnd(env, openSubArgv(env), "approved", { tty: true });
    expect(got.code).toBe(0);
    const data = JSON.parse(got.stdout) as Result;
    if (data.status !== "success") throw new Error("expected success");
    expect(data.outputs.account_number).toBe(ACCOUNT_NUMBER);
  });
});

describe("intyy replay: the start confirmation (docs/decisions.md, M05)", () => {
  test("off-terminal prints the operator decide line, and approving it proceeds", async () => {
    const env = await replayRoot();
    const started = startCall(env, openSubArgv(env));
    const runId = await waitForPrompt(started);
    expect(started.stderr()).toContain(`intyy operator decide ${runId} approved|declined`);
    let decided = await replayCall(env, ["operator", "decide", runId, "approved"]);
    const start = Date.now();
    while (decided.code !== 0 && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      decided = await replayCall(env, ["operator", "decide", runId, "approved"]);
    }
    expect(decided.code).toBe(0);
    const code = await started.code;
    expect(code).toBe(0);
    const data = JSON.parse(started.stdout()) as Result;
    expect(data.status).toBe("success");
  });

  test("on a TTY, a scripted question() answer decides it", async () => {
    const env = await replayRoot();
    const started = startCall(env, openSubArgv(env), { stdinTty: true, stderrTty: true, answers: ["y"] });
    const code = await started.code;
    expect(code).toBe(0);
    const data = JSON.parse(started.stdout()) as Result;
    expect(data.status).toBe("success");
  });
});

describe("intyy replay: Ctrl-C (section 9 §10.3)", () => {
  test("the first Ctrl-C ends the run failed, ended_by_operator", async () => {
    const env = await replayRoot();
    const started = startCall(env, openSubArgv(env));
    const runId = await waitForPrompt(started);
    // Waits for the mailbox to actually be open (past the CLI's own early print of "waiting
    // for a start confirmation", which comes before `runReplay` opens the request): this
    // covers Ctrl-C once the run is already waiting, alongside the test below, which covers
    // Ctrl-C arriving before that wait even starts.
    await waitForMailboxOpen(env, runId);
    // Why emit, not a real signal: this fires only the listeners this process's `replay`
    // command itself registered, with no risk to the test runner. Only the first press: a
    // second calls `process.exit`, which would end this whole test process.
    process.emit("SIGINT");
    const code = await started.code;
    expect(code).toBe(5);
    const data = JSON.parse(started.stdout()) as Result;
    expect(data.status).toBe("failed");
    if (data.status !== "failed") throw new Error("expected failed");
    expect(data.failure.code).toBe("ended_by_operator");
  });

  test("a Ctrl-C that arrives before the first mailbox wait still ends the run promptly", async () => {
    const env = await replayRoot();
    const started = startCall(env, openSubArgv(env));
    // Only as far as the CLI's own early print (its SIGINT listener is registered by then, but
    // `runReplay` has not yet opened the start confirmation's mailbox request): the signal is
    // already aborted by the time the supervisor gets there, proving it honors an
    // already-aborted signal instead of running out the full escalation deadline.
    await waitForPrompt(started);
    process.emit("SIGINT");
    const code = await started.code;
    expect(code).toBe(5);
    const data = JSON.parse(started.stdout()) as Result;
    expect(data.status).toBe("failed");
    if (data.status !== "failed") throw new Error("expected failed");
    expect(data.failure.code).toBe("ended_by_operator");
  });
});

describe("maskOutputsForDelivery (section 3 §5.13)", () => {
  test("financial and pii outputs become their literal placeholder; an unresolved sensitivity shows [pii]; all none changes nothing", () => {
    const result = successResult({ account_number: "SH1234567", note: "hello", ssn: "123-45-6789" });
    const masked = maskOutputsForDelivery(result, (name) =>
      name === "account_number" ? "financial" : name === "note" ? "none" : name === "ssn" ? "pii" : undefined,
    );
    if (masked.status !== "success") throw new Error("expected success");
    expect(masked.outputs).toEqual({ account_number: "[financial]", note: "hello", ssn: "[pii]" });
    expect(masked.warnings.some((w) => w.code === "outputs_masked")).toBe(true);

    // an output whose sensitivity cannot be resolved shows [pii]
    const unresolved = maskOutputsForDelivery(successResult({ account_number: "SH1234567" }), () => undefined);
    if (unresolved.status !== "success") throw new Error("expected success");
    expect(unresolved.outputs).toEqual({ account_number: "[pii]" });

    // every output labelled none: nothing changes, no warning added
    const none = maskOutputsForDelivery(successResult({ note: "hello" }), () => "none");
    if (none.status !== "success") throw new Error("expected success");
    expect(none.outputs).toEqual({ note: "hello" });
    expect(none.warnings.some((w) => w.code === "outputs_masked")).toBe(false);
  });
});

/** Runs one CLI command in `env.root`, as `staff` (mirrors this file's own `replayCall`, for
 * commands `replay-harness.ts` does not wrap, like `pack`). */
function cli(env: ReplayEnv, staff: string, argv: string[], extraEnv: Record<string, string> = {}) {
  return call(argv, { cwd: env.root, env: { INTYY_STAFF: staff, ...extraEnv }, deps: { commands } });
}

/** Seals (never approves: `loadFrozenSetFor` accepts a merely sealed pack, section 9 §8.5)
 * one global-scope pack with a single `needs_human` handler, through the real CLI (the
 * `EDITOR: cp` trick). No response action, so no risk decision or second look is needed. */
async function sealGlobalNeedsHumanPack(env: ReplayEnv, handlerId: string, detectorText: string): Promise<void> {
  const body = {
    schema: "intyy.pack/1.0",
    scope: { level: "global" },
    revision: 1,
    reason: "Test pack: proves library/packs loads into the frozen set (M06 task 8).",
    targets: [],
    conditions: [
      {
        id: `${handlerId}_shown`,
        check: "text_visible",
        description: "The detector text is visible",
        text: detectorText,
        match: "contains",
      },
    ],
    handlers: [
      {
        id: handlerId,
        description: "Proves a pack handler loads from library/packs.",
        class: "needs_human",
        detector: `${handlerId}_shown`,
        fixtures: { fire: [], no_fire: [] },
        operator_note: "Loaded from library/packs (M06 task 8 proof).",
      },
    ],
    provenance: { runs: [], decisions: [], sealed: null },
  };
  const editedPath = join(env.root, `pack-edited-${String(Math.random()).slice(2)}.json`);
  writeFileSync(editedPath, JSON.stringify(body));
  await cli(env, "op_017", ["pack", "edit", "global"], { EDITOR: `cp "${editedPath}"` });
  const sealed = await cli(env, "op_017", ["pack", "seal", "global"]);
  if (sealed.code !== 0) throw new Error(`test setup: pack seal failed: ${sealed.stderr}`);
}

/** Claims the open takeover as `op_017`, retrying past a transient "not open yet" refusal, like
 * {@link decideRetrying}. A claim comes first: `decide` on a takeover needs it (section 9 §10.4). */
async function claimRetrying(env: ReplayEnv, runId: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  let got = await replayCall(env, ["operator", "claim", runId]);
  while (got.code !== 0 && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    got = await replayCall(env, ["operator", "claim", runId]);
  }
  if (got.code !== 0) throw new Error(`test setup: operator claim failed: ${got.stderr}`);
}

/** Answers one open mailbox request with `word`, retrying past a transient "not yet open" or
 * "wrong slot" refusal (the same tolerant retry `runSupervisedToEnd` uses for the start
 * confirmation), until `timeoutMs` runs out. */
async function decideRetrying(env: ReplayEnv, runId: string, word: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  let got = await replayCall(env, ["operator", "decide", runId, word]);
  while (got.code !== 0 && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    got = await replayCall(env, ["operator", "decide", runId, word]);
  }
  if (got.code !== 0) throw new Error(`test setup: operator decide ${word} failed: ${got.stderr}`);
}

describe("replay loads library/packs into the frozen set (section 5 §7.4; M06 task 8)", () => {
  test("a sealed global needs_human handler fires: the escalation's reason is needs_human_handler, not the bare climb's stuck", async () => {
    const env = await replayRoot();
    // Why `homeMissingBox`: `home_shown` is a bare `location` check, so a run with no pack at
    // all climbs straight to rung 4 with reason `stuck` (docs/decisions.md, M06). Search's own
    // text stays on `/home` either way, so a handler detecting it fires first instead, proving
    // the pack this test seals was genuinely loaded, not the default empty set.
    await sealGlobalNeedsHumanPack(env, "search_text_shown_proof", "Search");
    const inputs = writeInputs(env, { member_id: MEMBER_FOUND });
    const auth = writeAuthorization(env, "kvfcu/open_sub@1");
    const started = startCall(
      env,
      [
        "replay",
        "kvfcu/open_sub@1",
        "--mode",
        "supervised",
        "--inputs",
        inputs,
        "--authorization",
        auth,
        "--json",
      ],
      { site: fixtureSite({ homeMissingBox: true }) },
    );
    const runId = await waitForPrompt(started);
    await decideRetrying(env, runId, "approved");
    await claimRetrying(env, runId);
    await decideRetrying(env, runId, "end_run");
    await started.code;

    const events = readEvents(env, runId);
    const decided = events.find(
      (e) =>
        (e as { event?: string }).event === "escalation" &&
        (e as { data?: { kind?: string; staff_id?: string } }).data?.kind === "takeover" &&
        (e as { data?: { staff_id?: string } }).data?.staff_id === "op_017",
    ) as { data?: { reason?: string } } | undefined;
    expect(decided?.data?.reason).toBe("needs_human_handler");
  });
});

/** A minimal `success` result, for `maskOutputsForDelivery`'s own unit tests. */
function successResult(outputs: Record<string, string>): Result {
  return {
    schema: "intyy.result/1.0",
    run_id: "run_2026-01-15_1000000009",
    request_id: "run_2026-01-15_1000000009",
    capability: { name: "kvfcu/open_sub", version: "1.0.0", patch_revision: null },
    warnings: [],
    recoveries: [],
    interventions: [],
    timing: { started_at: "2026-01-15T09:00:00.000Z", ended_at: "2026-01-15T09:00:01.000Z", duration_ms: 1000, human_ms: 0 },
    evidence: "runs/run_2026-01-15_1000000009",
    status: "success",
    outputs,
  };
}
