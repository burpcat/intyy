// Test helpers for whole discovery runs on the snapshot surface: a small sign-in site, a merged
// test policy, bank settings, and a real file evidence store in a temporary folder.
// Values are made up. Seed member 100240 is the canary and never appears.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FileCandidateStore, FileEvidenceStore } from "../../../src/adapters/files/other-stores.js";
import { runDiscovery, type DiscoveryResult } from "../../../src/core/orchestrator/discovery.js";
import { Artifact } from "../../../src/core/model/artifact.js";
import { CandidateDecision } from "../../../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../../../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../../../src/core/model/candidate-runs.js";
import { AppPolicy, GlobalPolicy, TenantPolicy } from "../../../src/core/model/policy.js";
import { RunSpec } from "../../../src/core/model/runspec.js";
import type { CandidateFiles } from "../../../src/core/recorder/candidates.js";
import { Settings } from "../../../src/core/model/settings.js";
import { mergePolicy, type MergeResult } from "../../../src/core/safety/policy/merge.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { SeededIds } from "../../../src/fakes/ids.js";
import { FakeMarker } from "../../../src/fakes/marker.js";
import { ScriptedPlanner, type Step } from "../../../src/fakes/scripted-planner.js";
import { MapSecrets } from "../../../src/fakes/secrets.js";
import { snapshotFactory, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { FakeOperator, type FakeAnswer } from "../../../src/fakes/operator.js";
import type { Clock } from "../../../src/ports/clock.js";
import type { Planner } from "../../../src/ports/models.js";
import type { Secrets } from "../../../src/ports/secrets.js";
import type { SurfaceFactory } from "../../../src/ports/surface.js";
import { readTree, tempRoot } from "../safety/canary-kit.js";

/** The test origin. Loopback, like every test host. */
export const ORIGIN = "http://127.0.0.1:9181";

/** A made-up operator password. The canary test looks for it in every file. */
export const PASSWORD = "Kvfcu-test-pass-5521";

const box = (y: number, x = 200) => ({ x, y, width: 160, height: 24 });

/** A sign-in page, a home page, and a transfer page with one irreversible button. */
export const SITE: FakeSite = {
  origin: ORIGIN,
  screens: {
    "/": {
      title: "Sign In",
      elements: [
        {
          id: "h",
          role: "heading",
          roleGroup: "container",
          text: "Teller Sign In",
          box: box(20, 16),
        },
        {
          id: "u_label",
          role: "generic",
          roleGroup: "container",
          text: "Username",
          box: box(60, 16),
        },
        {
          id: "user",
          role: "textbox",
          roleGroup: "text_entry",
          field: { kind: "text", value: "" },
          form: { id: "login", submits: false },
          box: box(60),
        },
        {
          id: "p_label",
          role: "generic",
          roleGroup: "container",
          text: "Password",
          box: box(100, 16),
        },
        {
          id: "pass",
          role: "textbox",
          roleGroup: "text_entry",
          field: { kind: "password", value: "" },
          form: { id: "login", submits: false },
          box: box(100),
        },
        {
          id: "go",
          role: "button",
          roleGroup: "button_like",
          name: "Sign In",
          form: { id: "login", submits: true },
          onClick: { go: "/home" },
          box: box(140),
        },
      ],
    },
    "/home": {
      title: "Teller Workstation",
      elements: [
        {
          id: "welcome",
          role: "heading",
          roleGroup: "container",
          text: "Welcome, teller",
          box: box(20, 16),
        },
        {
          id: "xfer",
          role: "link",
          roleGroup: "navigation",
          name: "Transfers",
          href: "/transfer",
          box: box(60, 16),
        },
      ],
    },
    "/transfer": {
      title: "Transfer",
      elements: [
        {
          id: "submit",
          role: "button",
          roleGroup: "button_like",
          name: "Submit Transfer",
          onClick: { go: "/done" },
          box: box(20, 16),
        },
      ],
    },
    "/done": {
      title: "Done",
      elements: [
        {
          id: "ok",
          role: "heading",
          roleGroup: "container",
          text: "Transfer posted",
          box: box(20, 16),
        },
      ],
    },
  },
};

/** The real, sealed global policy layer. Exported so a CLI-level test can seed a document store
 * with the same raw layers {@link testPolicy} merges (docs/decisions.md, M04). */
export const GLOBAL_LAYER = GlobalPolicy.parse(
  JSON.parse(
    readFileSync(new URL("../../../library/policy/global/1.json", import.meta.url), "utf8"),
  ),
);

/** A test kvfcu app layer: SITE's four paths, and both operator secrets on `/`. */
export const APP_LAYER = AppPolicy.parse({
  schema: "intyy.policy/1.0",
  scope: { level: "app", app: "kvfcu" },
  revision: 1,
  reason: "Test app layer.",
  paths: {
    allow: ["/", "/home", "/transfer", "/done"],
    deny: ["/__test__/*"],
    irreversible: [],
    case_sensitive: true,
  },
  secrets: {
    operator_username: { kind: "username", paths: ["/"] },
    operator_password: { kind: "password", paths: ["/"] },
  },
});

/** A test keystone tenant layer: allows `sign_in` and `transfer` on kvfcu. */
export const TENANT_LAYER = TenantPolicy.parse({
  schema: "intyy.policy/1.0",
  scope: { level: "tenant", tenant: "keystone" },
  revision: 1,
  reason: "Test tenant layer.",
  capabilities: { allow: ["kvfcu/sign_in@1", "kvfcu/transfer@1", "kvfcu/find_member@1"] },
});

/** The global layer, a test kvfcu app layer, and a keystone tenant layer, merged. */
export function testPolicy(): MergeResult {
  const merged = mergePolicy({ global: GLOBAL_LAYER, app: APP_LAYER, tenant: TENANT_LAYER, appName: "kvfcu" });
  if (!merged.ok) throw new Error(`test policy does not merge: ${merged.detail ?? ""}`);
  return merged.value;
}

/** Keystone's settings with the test origin. */
export const SETTINGS = Settings.parse({
  schema: "intyy.settings/1.0",
  tenant: "keystone",
  revision: 1,
  apps: {
    kvfcu: {
      origin: ORIGIN,
      app_version: "9.2",
      environment: "test",
      locale: "en-US",
      time_zone: "America/New_York",
      extra_origins: [],
      secrets: {
        operator_username: { source: "env", key: "INTYY_KEYSTONE_KVFCU_OPERATOR_USERNAME" },
        operator_password: { source: "env", key: "INTYY_KEYSTONE_KVFCU_OPERATOR_PASSWORD" },
      },
    },
  },
});

/** Section 6 §6.4's sign_in spec. */
export const SIGN_IN = RunSpec.parse({
  schema: "intyy.runspec/1.0",
  kind: "discovery",
  caller: { tenant: "keystone", agent_id: "op_017" },
  app: "kvfcu",
  capability: "sign_in",
  goal: "Sign in as the operator and reach the home page.",
  inputs: [],
  outputs: [],
  expected_effect: "read_only",
  session: null,
  entry: "/",
  model: "claude-sonnet-5",
  prompt: "discovery@1.0",
});

const why = { reason: "Needed to sign in.", expected: "The field fills.", tag: "flow_step" };

/** The four calls that sign in on SITE, then `done`, with IDs as the first screen lists them. */
export const SIGN_IN_STEPS: Step[] = [
  { name: "type", input: { element: "e3", value: "{secret.operator_username}", ...why } },
  { name: "type", input: { element: "e5", value: "{secret.operator_password}", ...why } },
  { name: "click", input: { element: "e6", ...why, expected: "The home page opens." } },
  { name: "done", input: { summary: "Signed in.", proof: ["e1"] } },
];

/** What a finished test run left behind. */
export type Ran = {
  result: DiscoveryResult;
  events: Record<string, unknown>[];
  files: { path: string; bytes: Uint8Array }[];
  root: string;
  planner: Planner;
  operator: FakeOperator;
  remove: () => Promise<void>;
};

/** Runs one discovery on SITE with a scripted planner and a fake operator. */
export async function run(opts: {
  steps?: Step[];
  planner?: Planner;
  spec?: RunSpec;
  answers?: FakeAnswer[];
  secrets?: Record<string, string>;
  site?: FakeSite;
  /** A ready surface, instead of one built from `site`. A test wraps the fake to change what it shows. */
  surface?: SurfaceFactory;
  /** A sealed session artifact, resolvable at `kvfcu/sign_in@1` (section 6 §5.5, M05 task 11).
   * Left out, the store stays empty, so a spec's `session` link never resolves. */
  sealedSession?: Artifact;
  /** A clock for the run, instead of the self-advancing {@link SteppingClock}. */
  clock?: Clock;
  /** A secrets port, instead of the map built from `secrets`. */
  secretsPort?: Secrets;
  /** The spec file's name written to `run.json`; the run's own default is `<app>/<capability>`. */
  specName?: string;
  /** The run's own signal (section 6 §10.4: an abort ends the run). */
  signal?: AbortSignal;
}): Promise<Ran> {
  const { root, remove } = await tempRoot("intyy-disc-");
  const evidence = new FileEvidenceStore({
    root: join(root, "evidence"),
    tmpDir: join(root, "tmp"),
  });
  const planner = opts.planner ?? new ScriptedPlanner(opts.steps ?? SIGN_IN_STEPS);
  const operator = new FakeOperator(opts.answers ?? []);
  const clock = opts.clock ?? new SteppingClock("2026-09-28T14:00:00.000Z");
  const ids = new SeededIds(clock);
  // Why: `runDiscovery` resolves a spec's `session` link, if any, through the artifact store
  // (section 6 §5.5, M05 task 11). None of `run-kit.ts`'s own specs link one, so an empty store
  // in the same temp root is enough, unless a test seals one through `opts.sealedSession`.
  const artifacts = new FileCandidateStore<CandidateFiles, ReturnType<typeof CandidateDecision.parse>>(
    {
      files: { "runs.json": CandidateRuns, "candidate.json": Artifact, "issues.json": CandidateIssues },
      decision: CandidateDecision,
    },
    { dir: join(root, "artifacts"), artifactsDir: join(root, "artifacts"), tmpDir: join(root, "tmp") },
    clock,
  );
  if (opts.sealedSession !== undefined) {
    const sealed = await artifacts.seal(
      "kvfcu/sign_in/cand_2026-09-28_1000000000",
      "1.0.0",
      "op_017",
      opts.sealedSession,
      {},
    );
    if (!sealed.ok) throw new Error(`run-kit: could not seal the test session artifact: ${sealed.detail ?? ""}`);
  }
  const result = await runDiscovery(
    {
      runId: ids.runId(),
      spec: opts.spec ?? SIGN_IN,
      ...(opts.specName === undefined ? {} : { specName: opts.specName }),
      tenant: "keystone",
      staff: "op_017",
      policy: testPolicy(),
      settings: { doc: SETTINGS, rev: "1", hash: `sha256:${"0".repeat(64)}` },
      engineVersion: "0.1.0",
      canaries: ["999999"],
      visible: false,
    },
    {
      evidence,
      clock,
      ids,
      secrets:
        opts.secretsPort ??
        new MapSecrets(
          opts.secrets ?? {
            INTYY_KEYSTONE_KVFCU_OPERATOR_USERNAME: "teller-one",
            INTYY_KEYSTONE_KVFCU_OPERATOR_PASSWORD: PASSWORD,
          },
        ),
      surface: opts.surface ?? snapshotFactory(opts.site ?? SITE),
      marker: new FakeMarker(),
      planner,
      operator: () => operator,
      artifacts,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    },
  ).catch(async (error: unknown) => {
    // Why: a throw leaves the caller no `remove` handle, so the temp root would leak.
    await remove();
    throw error instanceof Error ? error : new Error(String(error));
  });
  const ev = await evidence.events("keystone", result.runId);
  const events = ev.ok ? (ev.value as Record<string, unknown>[]) : [];
  const files = await readTree(join(root, "evidence", "keystone", "runs", result.runId));
  return { result, events, files, root, planner, operator, remove };
}

/** The event names, in order. */
export const names = (events: Record<string, unknown>[]): string[] =>
  events.map((e) => String(e.event));
