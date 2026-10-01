// Shared test harness for the demo-path live tests (tests/live/replay-demo.test.ts,
// tests/live/member-canary.test.ts): the approved library files, the real sealed-artifact
// store, the instance lock, and one `runOpenSub` call per replay. Not a test file: no
// `describe`/`test` here. Mirrors tests/live/cassette.test.ts's own harness. M05 task 13.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { EnvSecrets } from "../../src/adapters/env-secrets/secrets.js";
import { FileDocumentStore } from "../../src/adapters/files/document-store.js";
import { FileLockSlots, systemLockEnv } from "../../src/adapters/files/locks.js";
import { FileCandidateStore, FileEvidenceStore, FileLogStore } from "../../src/adapters/files/other-stores.js";
import { playwrightFactory } from "../../src/adapters/playwright/session.js";
import { SystemClock } from "../../src/adapters/system/clock.js";
import { SystemIds } from "../../src/adapters/system/ids.js";
import { loadDotEnv } from "../../src/cli/env.js";
import { LockManager } from "../../src/core/locks/manager.js";
import { Artifact } from "../../src/core/model/artifact.js";
import { CandidateDecision } from "../../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../../src/core/model/candidate-runs.js";
import { Config } from "../../src/core/model/config.js";
import { policyKind, settingsKind } from "../../src/core/model/kinds.js";
import type { AppPolicy, GlobalPolicy, TenantPolicy } from "../../src/core/model/policy.js";
import { Request } from "../../src/core/model/request.js";
import { RequestIndexLine } from "../../src/core/model/request-index.js";
import type { CandidateFiles } from "../../src/core/recorder/candidates.js";
import { runReplay, type ReplayDeps, type ReplayInput, type ReplayOutcome } from "../../src/core/replay/executor.js";
import { mergePolicy } from "../../src/core/safety/policy/merge.js";
import { FakeOperator } from "../../src/fakes/operator.js";
import type { LockHold } from "../../src/ports/locks.js";
import type { DocumentStore } from "../../src/ports/stores.js";
import { tempRoot } from "../unit/safety/canary-kit.js";

/** Repo root, three levels up from `tests/live/`. */
export const ROOT = join(import.meta.dirname, "../..");
/** The capability the whole demo path exercises (section 9 §13.2). */
export const CAP_LINK = "kvfcu/open_share_subaccount@1";
export const VISIBLE = process.env.INTYY_VISIBLE === "1";

export const config = Config.parse(JSON.parse(readFileSync(join(ROOT, "intyy.json"), "utf8")));
export const clock = new SystemClock();
export const ids = new SystemIds(clock);
export const locks = new LockManager(
  new FileLockSlots(join(ROOT, config.state, "var", "locks")),
  clock,
  systemLockEnv(),
);

/** The newest approved revision of one document, or a clear failure. */
async function approved<T>(
  store: DocumentStore<T>,
  id: string,
): Promise<{ doc: T; rev: string; hash: string }> {
  const rev = (await store.list({ id })).filter((s) => s.state === "approved").at(-1)?.rev;
  if (rev === undefined) throw new Error(`${id} has no approved revision. Seal and approve it first.`);
  const got = await store.get(id, rev);
  if (!got.ok) throw new Error(`${id} ${rev}: ${got.failure}`);
  return { doc: got.value.doc, rev, hash: got.value.hash };
}

/** The real, file-backed candidate store, over the repo's own `library/`. Read-only here: this
 * harness only ever resolves and reads, never seals. */
function realCandidateStore(tmpDir: string): FileCandidateStore<CandidateFiles, ReturnType<typeof CandidateDecision.parse>> {
  const lib = join(ROOT, config.library);
  return new FileCandidateStore<CandidateFiles, ReturnType<typeof CandidateDecision.parse>>(
    {
      files: { "runs.json": CandidateRuns, "candidate.json": Artifact, "issues.json": CandidateIssues },
      decision: CandidateDecision,
    },
    { dir: join(lib, "candidates"), artifactsDir: join(lib, "artifacts"), tmpDir },
    clock,
  );
}

/**
 * Throws with a clear, named message when `kvfcu/open_share_subaccount@1.0.0` is not sealed yet
 * (the owner discoveries this milestone still asks for, spec task 12). Never skip: a demo-path
 * test that silently skips proves nothing (the coordinator's own rule for this task).
 */
export async function requireSealedDemoArtifact(): Promise<void> {
  const sealed = await realCandidateStore(join(ROOT, config.state, "var", "tmp")).listSealedVersions(
    "kvfcu/open_share_subaccount",
  );
  if (!sealed.includes("1.0.0")) {
    throw new Error("kvfcu/open_share_subaccount@1.0.0 is not sealed yet; finish the M05 owner steps.");
  }
}

/** Takes the one bank-app instance lock (CONTRACT §2, section 9 §12.2): one live run at a
 * time. `command` names the caller, for the lock file's own record. */
export async function acquireInstanceLock(command: string): Promise<LockHold> {
  const taken = await locks.acquire("instance", "http_127.0.0.1_8080", {
    owner: ids.runId(),
    command,
    staff: null,
    waitMs: 0,
  });
  if (!taken.ok) throw new Error(`the bank app is busy: ${taken.detail ?? ""}`);
  return taken.value;
}

/** One `intyy.request/1.0` for `open_share_subaccount`, `inputs` given straight. No request
 * ID: neither live test here exercises the request index (docs/decisions.md, M05). */
function requestFor(inputs: Record<string, unknown>): Request {
  return Request.parse({
    schema: "intyy.request/1.0",
    request_id: null,
    capability: CAP_LINK,
    inputs,
    mode: "supervised",
  });
}

/** What one `runOpenSub` call leaves behind: the result, its masked event log, the temp data
 * root it wrote to (evidence and the request-index log only; never the real `state/`), and a
 * cleanup. The caller removes it once done reading. */
export type OpenSubRun = {
  outcome: ReplayOutcome;
  events: Record<string, unknown>[];
  root: string;
  remove: () => Promise<void>;
};

/**
 * Runs one supervised replay of `open_share_subaccount@1` against the live app, with `inputs`.
 * Uses the approved library policy and settings, and the operator secrets from `.env`, like
 * tests/live/cassette.test.ts. A fresh temp root holds this run's own evidence and
 * request-index files. A `FakeOperator` approves both the start confirmation and any
 * commit-point approval, so no human answers a prompt (each fresh `FakeOperator` instance
 * answers its own first request "approved": src/fakes/operator.ts), unless `opts.operator` gives
 * another one.
 */
export async function runOpenSub(
  inputs: Record<string, unknown>,
  opts: { operator?: ReplayDeps["operator"] } = {},
): Promise<OpenSubRun> {
  const lib = join(ROOT, config.library);
  const tmp = await tempRoot("intyy-replay-demo-");
  const tmpDir = join(tmp.root, "tmp");
  const policies = new FileDocumentStore(policyKind, { dir: join(lib, "policy"), tmpDir }, clock);
  const settingsStore = new FileDocumentStore(settingsKind, { dir: join(lib, "settings"), tmpDir }, clock);
  const merged = mergePolicy({
    global: (await approved(policies, "global")).doc as GlobalPolicy,
    app: (await approved(policies, "app/kvfcu")).doc as AppPolicy,
    tenant: (await approved(policies, `tenant/${config.default_tenant}`)).doc as TenantPolicy,
    appName: "kvfcu",
  });
  if (!merged.ok) throw new Error(`the approved policy does not merge: ${merged.detail ?? ""}`);
  const settings = await approved(settingsStore, config.default_tenant);
  const app = settings.doc.apps.kvfcu;
  if (app === undefined) throw new Error("settings have no kvfcu app configured");

  const env: Record<string, string | undefined> = { ...process.env };
  loadDotEnv(ROOT, env);

  const evidence = new FileEvidenceStore({ root: join(tmp.root, "evidence"), tmpDir });
  const requestIndexStore = new FileLogStore<RequestIndexLine, never>(
    { line: RequestIndexLine, record: z.never() },
    { dir: join(tmp.root, "request-index"), tmpDir },
  );
  const keys = (settings.doc.system_secrets?.request_index_keys ?? []).map((k) => ({
    keyId: k.key_id,
    status: k.status,
    binding: { source: k.source, key: k.key },
  }));

  const runId = ids.runId();
  const input: ReplayInput = {
    runId,
    request: requestFor(inputs),
    tenant: config.default_tenant,
    agentId: "agent_demo_test",
    policy: merged.value,
    settings: { doc: settings.doc, rev: settings.rev, hash: settings.hash },
    appVersion: app.app_version,
    engineVersion: "0.1.0",
    outputsRevealed: true,
    visible: VISIBLE,
  };
  const deps: ReplayDeps = {
    evidence,
    clock,
    ids,
    secrets: new EnvSecrets(env),
    surface: playwrightFactory(),
    artifacts: realCandidateStore(tmpDir),
    requestIndex: { store: requestIndexStore, clock, secrets: new EnvSecrets(env), keys },
    // Why `opts.operator`: the handoff live test (M07) scripts a person who takes over.
    operator: opts.operator ?? (() => new FakeOperator([{ staff: "op_bank_ops", decision: "approved" }])),
  };
  const outcome = await runReplay(input, deps);
  const ev = await evidence.events(config.default_tenant, outcome.runId);
  return {
    outcome,
    events: ev.ok ? (ev.value as Record<string, unknown>[]) : [],
    root: tmp.root,
    remove: tmp.remove,
  };
}

/** Reads one demo file under `demo/`. */
export function demoFile(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, "demo", name), "utf8")) as Record<string, unknown>;
}
