// Replays the sealed `kvfcu/sign_in@1.0.0` on the live bank app and proves the real replay path
// works (design section 7 §10, the prelude: sign_in is the session capability every other
// replay signs in with; section 6 §14.5: a secret-filled field's checkpoint is `*`, the wildcard,
// so it passes once the field holds any value and never compares the secret). The first real
// replay (the discovery prelude) failed `checkpoint_timeout` on exactly such a `field_value "*"`
// checkpoint. This test guards that path: status `success`, no checkpoint trouble in the log,
// the last checkpoint is the `/main.do` screen, and no secret value in any written file (the M03
// canary-scan pattern; values are never printed). Evidence goes to a temp root, never the real
// operator index. Fails loudly in `beforeAll`, never skips, until sign_in is sealed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { EnvSecrets } from "../../src/adapters/env-secrets/secrets.js";
import { FileDocumentStore } from "../../src/adapters/files/document-store.js";
import { FileCandidateStore, FileEvidenceStore, FileLogStore } from "../../src/adapters/files/other-stores.js";
import { playwrightFactory } from "../../src/adapters/playwright/session.js";
import { loadDotEnv } from "../../src/cli/env.js";
import { Artifact } from "../../src/core/model/artifact.js";
import { CandidateDecision } from "../../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../../src/core/model/candidate-runs.js";
import { policyKind, settingsKind } from "../../src/core/model/kinds.js";
import type { AppPolicy, GlobalPolicy, TenantPolicy } from "../../src/core/model/policy.js";
import { Request } from "../../src/core/model/request.js";
import { RequestIndexLine } from "../../src/core/model/request-index.js";
import type { CandidateFiles } from "../../src/core/recorder/candidates.js";
import { runReplay, type ReplayDeps, type ReplayInput } from "../../src/core/replay/executor.js";
import { scanForCanaries } from "../../src/core/safety/canary/scan.js";
import { mergePolicy } from "../../src/core/safety/policy/merge.js";
import { FakeOperator } from "../../src/fakes/operator.js";
import type { LockHold } from "../../src/ports/locks.js";
import { Secret } from "../../src/ports/secret.js";
import type { DocumentStore } from "../../src/ports/stores.js";
import { z } from "zod";
import { readTree, tempRoot } from "../unit/safety/canary-kit.js";
import { ROOT, acquireInstanceLock, clock, config, ids, locks } from "./replay-demo-kit.js";

const CAP = "kvfcu/sign_in";
const lib = join(ROOT, config.library);
let hold: LockHold | null = null;
const cleanups: (() => Promise<void>)[] = [];

/** The real, file-backed artifact store over `library/`. Read-only: this test only resolves. */
function realArtifacts(tmpDir: string): FileCandidateStore<CandidateFiles, ReturnType<typeof CandidateDecision.parse>> {
  return new FileCandidateStore<CandidateFiles, ReturnType<typeof CandidateDecision.parse>>(
    {
      files: { "runs.json": CandidateRuns, "candidate.json": Artifact, "issues.json": CandidateIssues },
      decision: CandidateDecision,
    },
    { dir: join(lib, "candidates"), artifactsDir: join(lib, "artifacts"), tmpDir },
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

beforeAll(async () => {
  const sealed = await realArtifacts(join(ROOT, config.state, "var", "tmp")).listSealedVersions(CAP);
  if (!sealed.includes("1.0.0")) throw new Error(`${CAP}@1.0.0 is not sealed yet; seal it first.`);
  hold = await acquireInstanceLock("test:live sign-in-replay");
});

afterAll(async () => {
  for (const c of cleanups.splice(0)) await c();
  if (hold !== null) await locks.release(hold);
});

test("sign_in@1 replays to success: every checkpoint passes, no secret is written", async () => {
  const tmp = await tempRoot("intyy-sign-in-replay-");
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
  expect(markers).toHaveLength(2);

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
  const input: ReplayInput = {
    runId: ids.runId(),
    request: Request.parse({
      schema: "intyy.request/1.0",
      request_id: null,
      capability: `${CAP}@1`,
      inputs: {},
      mode: "supervised",
    }),
    tenant: config.default_tenant,
    agentId: "agent_sign_in_test",
    policy: merged.value,
    settings: { doc: settings.doc, rev: settings.rev, hash: settings.hash },
    appVersion: app.app_version,
    engineVersion: "0.1.0",
    outputsRevealed: true,
    visible: process.env.INTYY_VISIBLE === "1",
  };
  const deps: ReplayDeps = {
    evidence,
    clock,
    ids,
    secrets,
    surface: playwrightFactory(),
    artifacts: realArtifacts(tmpDir),
    requestIndex: { store: requestIndexStore, clock, secrets: new EnvSecrets(env), keys },
    operator: () => new FakeOperator([{ staff: "op_bank_ops", decision: "approved" }]),
  };

  const outcome = await runReplay(input, deps);
  const failure = outcome.result.status === "failed" ? outcome.result.failure : null;
  expect(outcome.result.status, `failure: ${failure?.code ?? "none"} at ${failure?.step ?? "none"}`).toBe("success");

  const ev = await evidence.events(config.default_tenant, outcome.runId);
  expect(ev.ok).toBe(true);
  const events = (ev.ok ? ev.value : []) as Record<string, unknown>[];
  // No checkpoint trouble: no ladder line, no escalation other than the start confirmation
  // (a supervised run always asks it, section 7 §4), no failed check, no timeout code.
  const kindOf = (e: Record<string, unknown>): unknown => (e.data as { kind?: unknown } | undefined)?.kind;
  expect(
    events.filter((e) => e.event === "ladder" || (e.event === "escalation" && kindOf(e) !== "start_confirmation")),
  ).toEqual([]);
  expect(events.filter((e) => (e.data as { passed?: unknown } | undefined)?.passed === false)).toEqual([]);
  expect(JSON.stringify(events)).not.toContain("checkpoint_timeout");
  expect(events.at(-1)).toMatchObject({ event: "run_end", data: { status: "success" } });

  // Why read the artifact: a success result holds no final screen address, but success means
  // the last step's checkpoint passed. Pin that this checkpoint is the `/main.do` screen.
  const sealed = Artifact.parse(
    JSON.parse(readFileSync(join(lib, "artifacts", CAP, "1.0.0", "artifact.json"), "utf8")),
  );
  const lastStep = sealed.steps.at(-1);
  const lastCheckpoint = sealed.conditions.find((c) => c.id === lastStep?.checkpoint);
  expect(JSON.stringify(lastCheckpoint)).toContain('"pattern":"/main.do"');

  // The M03 canary scan: no bound secret value, in any form, in any file this run wrote.
  const files = await readTree(tmp.root);
  expect(files.length).toBeGreaterThan(0);
  expect(scanForCanaries(files, markers)).toEqual([]);
}, 60_000);
