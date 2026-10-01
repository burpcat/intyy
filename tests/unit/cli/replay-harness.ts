// Shared test harness for the replay CLI (`intyy replay`, `intyy run`, `intyy operator`): the
// real, file-backed `wire()` under a temporary data root, with policy, settings, and the
// discovery ports swapped for fakes matching the sign_in/open_sub fixture artifacts already
// used at the executor level (tests/unit/replay/executor-harness.ts). Not a test file: no
// `describe`/`test` here. Follows design section 9 §10.1 to §10.3; M05 task 9.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wire as realWire, type Wiring } from "../../../src/cli/wiring.js";
import { commands } from "../../../src/cli/commands/index.js";
import { run } from "../../../src/cli/program.js";
import type { Io } from "../../../src/cli/output.js";
import { stubSweep, type Sweep } from "../../../src/cli/sweep.js";
import { MailboxOperator } from "../../../src/adapters/mailbox/mailbox.js";
import { Config } from "../../../src/core/model/config.js";
import { policyKind, settingsKind } from "../../../src/core/model/kinds.js";
import {
  AppPolicy,
  GlobalPolicy,
  TenantPolicy,
  type Policy,
} from "../../../src/core/model/policy.js";
import { Settings } from "../../../src/core/model/settings.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { FakeDocumentStore } from "../../../src/fakes/stores.js";
import { FakeMarker } from "../../../src/fakes/marker.js";
import type { FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { snapshotFactory } from "../../../src/fakes/snapshot-surface/index.js";
import {
  ACCOUNT_NUMBER,
  CHECK_SUB,
  MEMBER_FOUND,
  MEMBER_MISSING,
  OPEN_SUB,
  OPEN_SUB_CHECKED,
  ORIGIN,
  SIGN_IN,
  TENANT,
  fixtureSite,
  type SiteOpts,
} from "../replay/executor-harness.js";
import { tempRoot } from "./helpers.js";

export { ACCOUNT_NUMBER, MEMBER_FOUND, MEMBER_MISSING, ORIGIN, TENANT, fixtureSite, type SiteOpts };
export { stubSweep, type Sweep };

/** The env variable the request index's one signing key is bound to (section 4 §8.11). */
export const REQUEST_INDEX_ENV = "INTYY_KEYSTONE_REQUEST_INDEX_KEY_K1";
const REQUEST_INDEX_KEY_VALUE = "test-request-index-key";

const GLOBAL_LAYER = GlobalPolicy.parse(
  JSON.parse(
    readFileSync(new URL("../../../library/policy/global/1.json", import.meta.url), "utf8"),
  ),
);

/** A test kvfcu app layer: the fixture site's four paths, no secrets (neither fixture artifact
 * types one). */
function appLayer(): Policy {
  return AppPolicy.parse({
    schema: "intyy.policy/1.0",
    scope: { level: "app", app: "kvfcu" },
    revision: 1,
    reason: "Test app layer.",
    paths: {
      allow: ["/", "/home", "/result", "/done", "/check"],
      deny: [],
      irreversible: [],
      case_sensitive: true,
    },
    secrets: {},
  });
}

/** A test keystone tenant layer: allows every kvfcu major-1 capability. */
function tenantLayer(): Policy {
  return TenantPolicy.parse({
    schema: "intyy.policy/1.0",
    scope: { level: "tenant", tenant: TENANT },
    revision: 1,
    reason: "Test tenant layer.",
    capabilities: { allow: ["kvfcu/*@1"] },
  });
}

/** `settingsOverrides` lets a test build a settings doc that fails `--reveal-outputs`'s own
 * checks (a non-test environment, or a non-loopback origin), without touching the fixture site. */
function settingsDoc(
  overrides: { environment?: "test" | "production"; origin?: string } = {},
): Settings {
  return Settings.parse({
    schema: "intyy.settings/1.0",
    tenant: TENANT,
    revision: 1,
    apps: {
      kvfcu: {
        origin: overrides.origin ?? ORIGIN,
        app_version: "8.4",
        environment: overrides.environment ?? "test",
        locale: "en-US",
        time_zone: "America/New_York",
        extra_origins: [],
        secrets: {},
      },
    },
    system_secrets: {
      request_index_keys: [
        { key_id: "k1", source: "env", key: REQUEST_INDEX_ENV, status: "current" },
      ],
    },
  });
}

/** Seals and approves `docs` into a fresh in-memory policy store (mirrors candidate.test.ts). */
async function sealedPolicyStore(docs: readonly Policy[]): Promise<FakeDocumentStore<Policy>> {
  const clock = new SteppingClock("2026-01-15T08:00:00.000Z");
  const policy = new FakeDocumentStore<Policy>(policyKind, clock);
  for (const raw of docs) {
    const doc = { ...raw, approved: undefined } as Policy;
    const id = policyKind.idOf?.(doc) ?? "";
    await policy.putCandidate(id, doc);
    const sealed = await policy.seal(id, "op_017");
    if (!sealed.ok) throw new Error("test setup: policy seal failed");
    await policy.approve(id, sealed.value.rev, "op_022");
  }
  return policy;
}

/** Seals and approves one settings doc into a fresh in-memory store. */
async function sealedSettingsStore(doc: Settings): Promise<FakeDocumentStore<Settings>> {
  const clock = new SteppingClock("2026-01-15T08:00:00.000Z");
  const settings = new FakeDocumentStore<Settings>(settingsKind, clock);
  await settings.putCandidate(TENANT, doc);
  const sealed = await settings.seal(TENANT, "op_017");
  if (!sealed.ok) throw new Error("test setup: settings seal failed");
  await settings.approve(TENANT, sealed.value.rev, "op_022");
  return settings;
}

/** Seals both fixture artifacts into the real, file-backed candidate store at `root`. */
async function sealArtifacts(root: string): Promise<void> {
  const config = Config.parse(JSON.parse(readFileSync(join(root, "intyy.json"), "utf8")));
  const wiring = realWire(root, config, {});
  const sealedSignIn = await wiring.candidates.seal(
    "kvfcu/sign_in/cand_2026-01-15_1000000001",
    "1.0.0",
    "op_017",
    SIGN_IN,
    {},
  );
  if (!sealedSignIn.ok) throw new Error("test setup: sign_in seal failed");
  const sealedOpenSub = await wiring.candidates.seal(
    "kvfcu/open_sub/cand_2026-01-15_1000000002",
    "1.0.0",
    "op_017",
    OPEN_SUB,
    {},
  );
  if (!sealedOpenSub.ok) throw new Error("test setup: open_sub seal failed");
  const sealedCheckSub = await wiring.candidates.seal(
    "kvfcu/check_sub/cand_2026-01-15_1000000003",
    "1.0.0",
    "op_017",
    CHECK_SUB,
    {},
  );
  if (!sealedCheckSub.ok) throw new Error("test setup: check_sub seal failed");
  const sealedOpenSubChecked = await wiring.candidates.seal(
    "kvfcu/open_sub_checked/cand_2026-01-15_1000000004",
    "1.0.0",
    "op_017",
    OPEN_SUB_CHECKED,
    {},
  );
  if (!sealedOpenSubChecked.ok) throw new Error("test setup: open_sub_checked seal failed");
}

/** One CLI test's root, plus its policy and settings stores, ready for `replayCall`. */
export type ReplayEnv = {
  root: string;
  policy: FakeDocumentStore<Policy>;
  settings: FakeDocumentStore<Settings>;
};

/** The real, file-backed wiring for `env.root`: its evidence store, candidate store, and lock
 * manager, all pointed at the same files a `replayCall` would use. For a test that seeds a
 * crashed run directly, or inspects a lock, without going through the CLI. */
export function realWiringOf(env: ReplayEnv): ReturnType<typeof realWire> {
  const config = Config.parse(JSON.parse(readFileSync(join(env.root, "intyy.json"), "utf8")));
  return realWire(env.root, config, {});
}

/** A fresh temp root, both fixture artifacts sealed, and approved policy and settings.
 * `settingsOverrides` lets a `--reveal-outputs` test build a settings doc that fails its own
 * checks, without touching the fixture site's origin. */
export async function replayRoot(
  settingsOverrides: { environment?: "test" | "production"; origin?: string } = {},
): Promise<ReplayEnv> {
  const root = tempRoot();
  await sealArtifacts(root);
  const policy = await sealedPolicyStore([GLOBAL_LAYER, appLayer(), tenantLayer()]);
  const settings = await sealedSettingsStore(settingsDoc(settingsOverrides));
  return { root, policy, settings };
}

/** Writes `name` (default `inputs.json`) under `env.root` as JSON, and returns its path. For
 * `--inputs`, `--request`, or any other file-taking flag a test needs. */
export function writeInputs(env: ReplayEnv, inputs: unknown, name = "inputs.json"): string {
  const path = join(env.root, name);
  writeFileSync(path, JSON.stringify(inputs));
  return path;
}

/** Writes a valid `--authorization` file for `capability`, bracketing the real wall clock (the
 * CLI runs on the real `SystemClock`, unlike the executor's own unit tests): without it, the
 * commit step pauses for a second, separate approval request (section 4 §7.8 check 1). */
export function writeAuthorization(env: ReplayEnv, capability: string): string {
  const now = Date.now();
  const path = join(env.root, "authorization.json");
  writeFileSync(
    path,
    JSON.stringify({
      consent_ref: "consent_1",
      granted_by: "member",
      granted_at: new Date(now - 60_000).toISOString(),
      expires_at: new Date(now + 20 * 60_000).toISOString(),
      capability,
    }),
  );
  return path;
}

/** What `startCall` returns: the exit code (once the command ends), and live reads of what it
 * has printed so far — unlike `helpers.ts`'s `call`, which only resolves once the whole command
 * is done. A paused, supervised run needs to be observed mid-flight. */
export type Started = { code: Promise<number>; stdout: () => string; stderr: () => string };

/** One `startCall`/`replayCall` request. */
export type CallOpts = {
  site?: FakeSite;
  tty?: boolean;
  stdinTty?: boolean;
  stderrTty?: boolean;
  stdin?: string;
  /** Answers to `question()`, in order. A function runs when its question is asked, so a test can
   * change the world mid-conversation. */
  answers?: readonly (string | (() => string | Promise<string>))[];
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** Replaces the program hook's own crash sweep (section 9 §7.8). A test that wants to prove
   * `run sweep`'s own body in isolation, clear of the hook's sweep racing ahead of it, passes
   * `stubSweep` here. */
  sweep?: Sweep;
  /** Replaces `wiring.reviewer`, so a test can see whether (and with which key) the replay
   * command asks for the rung 3 reviewer (design section 5 §11.5; M09). */
  reviewer?: Wiring["reviewer"];
};

/** Starts one `intyy` call against `env`, without waiting for it to end. The real `wire()`,
 * with policy, settings, and the discovery ports (surface, marker, planner, operator) swapped. */
export function startCall(env: ReplayEnv, argv: readonly string[], opts: CallOpts = {}): Started {
  let stdout = "";
  let stderr = "";
  const answers = [...(opts.answers ?? [])];
  const io: Io = {
    stdout: { write: (t) => (stdout += t), isTTY: opts.tty ?? false },
    stderr: { write: (t) => (stderr += t), isTTY: opts.stderrTty ?? false },
    stdin: {
      isTTY: opts.stdinTty ?? false,
      readAll: () => Promise.resolve(opts.stdin ?? ""),
      question: async () => {
        const next = answers.shift();
        return typeof next === "function" ? next() : (next ?? "");
      },
    },
    // Why a default staff: `operator decide` needs the operator role (section 9 §7.7); op_017
    // holds it for every tenant, per tests/unit/cli/helpers.ts's STAFF fixture.
    env: { [REQUEST_INDEX_ENV]: REQUEST_INDEX_KEY_VALUE, INTYY_STAFF: "op_017", ...opts.env },
    cwd: env.root,
  };
  const site = opts.site ?? fixtureSite();
  const code = run(argv, io, {
    commands,
    ...(opts.sweep === undefined ? {} : { sweep: opts.sweep }),
    wire: (root, config, wireEnv) => ({
      ...realWire(root, config, wireEnv),
      ...(opts.reviewer === undefined ? {} : { reviewer: opts.reviewer }),
      policy: env.policy,
      settings: env.settings,
      discovery: {
        surface: () => snapshotFactory(site),
        marker: () => new FakeMarker(),
        planner: () => {
          throw new Error("replay never opens a model");
        },
        operator: (r) =>
          // Why a real mailbox, fast polling: the CLI's own `operator decide` must be able to
          // answer it, over the same files (section 9 §10.4, §10.5).
          new MailboxOperator(
            {
              evidenceRoot: join(root, config.state, "evidence"),
              tmpDir: join(root, config.state, "var", "tmp"),
            },
            r,
            30,
          ),
      },
    }),
  });
  return { code, stdout: () => stdout, stderr: () => stderr };
}

/** Runs one `intyy` call to completion. */
export async function replayCall(
  env: ReplayEnv,
  argv: readonly string[],
  opts: CallOpts = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const started = startCall(env, argv, opts);
  const code = await started.code;
  return { code, stdout: started.stdout(), stderr: started.stderr() };
}

/** Polls `check` until it is true, or throws past `timeoutMs`. CLI tests only: real runs need
 * real waiting (the mailbox adapter polls real files). */
export async function waitUntil(
  check: () => boolean,
  timeoutMs = 5000,
  stepMs = 15,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Waits until a run's mailbox request is genuinely open on disk, past the CLI's own early
 * print of the "answer with: intyy operator decide ..." line (docs/decisions.md, M05: the
 * line prints before `runReplay` opens the mailbox request itself; see the report's Ctrl-C
 * finding for why this matters). Uses `operator show`, read-only, so it never records a
 * decision itself. */
export async function waitForMailboxOpen(env: ReplayEnv, runId: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    const got = await replayCall(env, ["operator", "show", runId]);
    if (got.code === 0) return;
    if (Date.now() - start > 5000) throw new Error("waitForMailboxOpen: timed out");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** The run ID named in the "answer with: intyy operator decide <run_id> ..." line. */
export function runIdFromPrompt(text: string): string {
  const m = /intyy operator decide (\S+) approved\|declined/.exec(text);
  if (m?.[1] === undefined) throw new Error(`no start-confirmation prompt found in: ${text}`);
  return m[1];
}

/** Waits for a paused, supervised run's off-terminal prompt, and returns its run ID. */
export async function waitForPrompt(started: Started): Promise<string> {
  await waitUntil(() => /intyy operator decide \S+ approved\|declined/.test(started.stderr()));
  return runIdFromPrompt(started.stderr());
}

/** Runs one supervised, off-terminal `replay` call to its end: waits for the start
 * confirmation's prompt, answers it through `intyy operator decide`, then waits for the run
 * itself to end. */
export async function runSupervisedToEnd(
  env: ReplayEnv,
  argv: readonly string[],
  decision: "approved" | "declined" = "approved",
  opts: CallOpts = {},
): Promise<{ code: number; stdout: string; stderr: string; runId: string }> {
  const started = startCall(env, argv, opts);
  const runId = await waitForPrompt(started);
  // Why retry: the prompt prints before `runReplay` opens the mailbox request itself (the CLI
  // prints it up front, then awaits the run); the actual `request.json` lands a little later.
  const start = Date.now();
  let decided = await replayCall(env, ["operator", "decide", runId, decision]);
  while (decided.code !== 0 && Date.now() - start < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    decided = await replayCall(env, ["operator", "decide", runId, decision]);
  }
  if (decided.code !== 0) throw new Error(`test setup: operator decide failed: ${decided.stderr}`);
  const code = await started.code;
  return { code, stdout: started.stdout(), stderr: started.stderr(), runId };
}

/** Reads `run.json` straight off disk: the real, file-backed evidence store's own bytes,
 * bypassing every CLI command (so a test can check exactly what is stored, unfiltered). */
export function readRunJson(env: ReplayEnv, runId: string): unknown {
  return JSON.parse(
    readFileSync(join(env.root, "state", "evidence", TENANT, "runs", runId, "run.json"), "utf8"),
  );
}

/** Reads every line of `events.jsonl` straight off disk. */
export function readEvents(env: ReplayEnv, runId: string): unknown[] {
  const text = readFileSync(
    join(env.root, "state", "evidence", TENANT, "runs", runId, "events.jsonl"),
    "utf8",
  );
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}
