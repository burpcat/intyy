// Replays against the live bank app three times with the same recipe failure at one step, and proves
// the live trust path (design section 8 §5.5 live lines, §5.6 replay writes them after `run_end`,
// §12.3 the streak rule: three recipe failures in a row at one step and one code degrade an approved
// key at once, with a `degraded` line by `live_score`): each run writes one live line, the key stays
// `approved` after two runs and is `degraded` after the third, and the `degraded` line names the
// streak rule and the three run IDs. The sealed `kvfcu/sign_in@1.0.0` is copied into a temporary
// library with one target changed so it can never be found; scores, locks, and evidence live in a
// temporary data root, never in the real `state/`. No secret value lands in any file. Fails loudly in
// `beforeAll`, never skips, until the sealed sign_in, the approved policy and settings, and the
// operator secrets in `.env` exist. M11 task 2.
import { join } from "node:path";
import { z } from "zod";
import { afterAll, beforeAll, expect, test } from "vitest";
import { EnvSecrets } from "../../src/adapters/env-secrets/secrets.js";
import { FileDocumentStore } from "../../src/adapters/files/document-store.js";
import { FileLockSlots, systemLockEnv } from "../../src/adapters/files/locks.js";
import { FileCandidateStore, FileEvidenceStore, FileLogStore } from "../../src/adapters/files/other-stores.js";
import { FileScoreStore } from "../../src/adapters/files/score-store.js";
import { playwrightFactory } from "../../src/adapters/playwright/session.js";
import { loadDotEnv } from "../../src/cli/env.js";
import { LockManager } from "../../src/core/locks/manager.js";
import { Artifact } from "../../src/core/model/artifact.js";
import { CandidateDecision } from "../../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../../src/core/model/candidate-runs.js";
import { policyKind, settingsKind } from "../../src/core/model/kinds.js";
import type { AppPolicy, GlobalPolicy, TenantPolicy } from "../../src/core/model/policy.js";
import { Request } from "../../src/core/model/request.js";
import { RequestIndexLine } from "../../src/core/model/request-index.js";
import { HistoryLine } from "../../src/core/model/score-history.js";
import { ScoreRecord, type ScoreKey } from "../../src/core/model/score.js";
import type { CandidateFiles } from "../../src/core/recorder/candidates.js";
import { runReplay, type ReplayDeps, type ReplayInput } from "../../src/core/replay/executor.js";
import { scanForCanaries } from "../../src/core/safety/canary/scan.js";
import { mergePolicy } from "../../src/core/safety/policy/merge.js";
import { keyPath } from "../../src/core/trust/keys.js";
import { classOfCode } from "../../src/core/trust/live-class.js";
import { appendHistory } from "../../src/core/trust/scores.js";
import { FakeOperator } from "../../src/fakes/operator.js";
import type { LockHold } from "../../src/ports/locks.js";
import { Secret } from "../../src/ports/secret.js";
import type { DocumentStore } from "../../src/ports/stores.js";
import { approved as approvedLine, batch } from "../unit/trust/kit.js";
import { readTree, tempRoot } from "../unit/safety/canary-kit.js";
import { ROOT, acquireInstanceLock, clock, config, ids, locks } from "./replay-demo-kit.js";

const CAP = "kvfcu/sign_in";
const lib = join(ROOT, config.library);
let hold: LockHold | null = null;
const cleanups: (() => Promise<void>)[] = [];

type Candidates = FileCandidateStore<CandidateFiles, ReturnType<typeof CandidateDecision.parse>>;

/** A file-backed artifact store: the real `library/` (read only here), or a temporary one. */
function artifactStore(dir: string, artifactsDir: string, tmpDir: string): Candidates {
  return new FileCandidateStore<CandidateFiles, ReturnType<typeof CandidateDecision.parse>>(
    {
      files: { "runs.json": CandidateRuns, "candidate.json": Artifact, "issues.json": CandidateIssues },
      decision: CandidateDecision,
    },
    { dir, artifactsDir, tmpDir },
    clock,
  );
}

/** The newest approved revision of one document, or a clear failure. */
async function approved<T>(store: DocumentStore<T>, id: string): Promise<{ doc: T; rev: string; hash: string }> {
  const rev = (await store.list({ id })).filter((s) => s.state === "approved").at(-1)?.rev;
  if (rev === undefined) throw new Error(`${id} has no approved revision. Seal and approve it first.`);
  const got = await store.get(id, rev);
  if (!got.ok) throw new Error(`${id} ${rev}: ${got.failure}`);
  return { doc: got.value.doc, rev, hash: got.value.hash };
}

/** The sealed sign_in with its first target made impossible to find: a recipe failure at the first step. */
function broken(sealed: unknown): unknown {
  const art = Artifact.parse(sealed);
  const targets = art.targets.map((t, i) =>
    i === 0 ? { ...t, clues: { role: "tab" as const, name: "Zz Missing Field", label: "Zz Missing Field" } } : t,
  );
  return Artifact.parse({ ...art, targets });
}

beforeAll(async () => {
  const real = artifactStore(join(lib, "candidates"), join(lib, "artifacts"), join(ROOT, config.state, "var", "tmp"));
  const sealed = await real.listSealedVersions(CAP);
  if (!sealed.includes("1.0.0")) throw new Error(`${CAP}@1.0.0 is not sealed yet; seal it first.`);
  hold = await acquireInstanceLock("test:live live-trust-degrade");
});

afterAll(async () => {
  for (const c of cleanups.splice(0)) await c();
  if (hold !== null) await locks.release(hold);
});

test("three recipe failures in a row at one step write three live lines and degrade the approved key", async () => {
  const tmp = await tempRoot("intyy-live-trust-");
  cleanups.push(tmp.remove);
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
  const secrets = new EnvSecrets(env);
  // The bound secret values, for the scan only. Both must resolve, or the scan proves nothing.
  const markers: string[] = [];
  for (const binding of Object.values(app.secrets)) {
    const got = await secrets.resolve(binding);
    if (got.ok) markers.push(Secret.open(got.value));
  }
  expect(markers, "both operator secrets must resolve from .env").toHaveLength(2);

  // A temporary library holds the broken copy, sealed as 1.0.0, so the real library is never touched.
  const real = artifactStore(join(lib, "candidates"), join(lib, "artifacts"), tmpDir);
  const original = await real.getSealedArtifact(CAP, "1.0.0");
  if (!original.ok) throw new Error(`${CAP}@1.0.0 cannot be read: ${original.failure}`);
  const temp = artifactStore(join(tmp.root, "library", "candidates"), join(tmp.root, "library", "artifacts"), tmpDir);
  const sealedCopy = await temp.seal("kvfcu/sign_in/cand_2026-01-15_1000000001", "1.0.0", "op_017", broken(original.value), {});
  if (!sealedCopy.ok) throw new Error(`the temporary seal failed: ${sealedCopy.detail ?? sealedCopy.failure}`);

  const scores = new FileScoreStore({ line: HistoryLine, record: ScoreRecord }, { dir: join(tmp.root, "scores"), tmpDir });
  const scoreLocks = new LockManager(new FileLockSlots(join(tmp.root, "locks")), clock, systemLockEnv());
  const key: ScoreKey = { capability: `${CAP}@1.0.0`, tenant: config.default_tenant, app_version: app.app_version, patch_revision: null };
  const path = keyPath(key);
  // Approved long before the runs, so every live line counts (the rules read lines after the approval).
  for (const line of [batch(1, "batch_a"), approvedLine(2)]) {
    const r = await appendHistory({ scores, locks: scoreLocks, artifacts: temp }, key, line, { owner: "test", command: "test", staff: "op_022" });
    if (!r.ok) throw new Error(`test setup: ${r.detail ?? r.failure}`);
  }

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
  const liveFailures: string[] = [];
  const deps: ReplayDeps = {
    evidence,
    clock,
    ids,
    secrets,
    surface: playwrightFactory(),
    artifacts: temp,
    requestIndex: { store: requestIndexStore, clock, secrets: new EnvSecrets(env), keys },
    scores,
    locks: scoreLocks,
    onLiveFailure: (f) => liveFailures.push(`${f.key}: ${f.reason}`),
    operator: () => new FakeOperator([{ staff: "op_bank_ops", decision: "approved" }]),
  };
  const replay = (): Promise<Awaited<ReturnType<typeof runReplay>>> => {
    const input: ReplayInput = {
      runId: ids.runId(),
      request: Request.parse({ schema: "intyy.request/1.0", request_id: null, capability: `${CAP}@1`, inputs: {}, mode: "supervised" }),
      tenant: config.default_tenant,
      agentId: "agent_live_trust_test",
      policy: merged.value,
      settings: { doc: settings.doc, rev: settings.rev, hash: settings.hash },
      appVersion: app.app_version,
      engineVersion: "0.1.0",
      outputsRevealed: true,
      visible: process.env.INTYY_VISIBLE === "1",
    };
    return runReplay(input, deps);
  };
  const stateNow = async (): Promise<string> => {
    const rec = await scores.getRecord(path);
    return rec.ok ? rec.value.state : "no record";
  };

  const runIds: string[] = [];
  const failures: { code: string; step: string | null }[] = [];
  for (let i = 0; i < 3; i++) {
    const outcome = await replay();
    runIds.push(outcome.runId);
    if (outcome.result.status !== "failed") throw new Error(`run ${String(i + 1)} did not fail: ${outcome.result.status}`);
    failures.push({ code: outcome.result.failure.code, step: outcome.result.failure.step });
    expect(classOfCode(outcome.result.failure.code), `run ${String(i + 1)} failed with ${outcome.result.failure.code}, which is not a recipe code`).toBe("recipe_failure");
    const lines = await scores.liveLines(path);
    expect(lines.ok && lines.value.map((l) => l.run_id)).toEqual(runIds);
    // Two failures are not yet a streak.
    expect(await stateNow()).toBe(i < 2 ? "approved" : "degraded");
  }
  // The same code at the same step all three times, or the streak rule never applied.
  expect(failures[1]).toEqual(failures[0]);
  expect(failures[2]).toEqual(failures[0]);

  const lines = await scores.liveLines(path);
  expect(lines.ok && lines.value).toMatchObject(runIds.map((id) => ({ run_id: id, as: "task", class: "recipe_failure", ...failures[0] })));
  const history = await scores.history(path);
  expect(history.ok && history.value.at(-1)).toMatchObject({ event: "degraded", by: "live_score", rule: "streak", runs: runIds });
  const record = await scores.getRecord(path);
  expect(record.ok && record.value).toMatchObject({ state: "degraded", state_by: "live_score" });
  expect(liveFailures).toEqual([]);

  // The M03 canary scan: no bound secret value, in any form, in any file this test wrote.
  const files = await readTree(tmp.root);
  expect(files.length).toBeGreaterThan(0);
  expect(scanForCanaries(files, markers)).toEqual([]);
}, 180_000);
