// Test helpers for whole discovery runs on the snapshot surface: a small sign-in site, a merged
// test policy, bank settings, and a real file evidence store in a temporary folder.
// Values are made up. Seed member 100240 is the canary and never appears.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FileEvidenceStore } from "../../../src/adapters/files/other-stores.js";
import { runDiscovery, type DiscoveryResult } from "../../../src/core/orchestrator/discovery.js";
import { AppPolicy, GlobalPolicy, TenantPolicy } from "../../../src/core/model/policy.js";
import { RunSpec } from "../../../src/core/model/runspec.js";
import { Settings } from "../../../src/core/model/settings.js";
import { mergePolicy, type MergeResult } from "../../../src/core/safety/policy/merge.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { SeededIds } from "../../../src/fakes/ids.js";
import { FakeMarker } from "../../../src/fakes/marker.js";
import { ScriptedPlanner, type Step } from "../../../src/fakes/scripted-planner.js";
import { MapSecrets } from "../../../src/fakes/secrets.js";
import { snapshotFactory, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { FakeOperator, type FakeAnswer } from "../../../src/fakes/operator.js";
import type { Planner } from "../../../src/ports/models.js";
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

const globalLayer = GlobalPolicy.parse(
  JSON.parse(
    readFileSync(new URL("../../../library/policy/global/1.json", import.meta.url), "utf8"),
  ),
);

/** The global layer, a test kvfcu app layer, and a keystone tenant layer, merged. */
export function testPolicy(): MergeResult {
  const app = AppPolicy.parse({
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
  const tenant = TenantPolicy.parse({
    schema: "intyy.policy/1.0",
    scope: { level: "tenant", tenant: "keystone" },
    revision: 1,
    reason: "Test tenant layer.",
    capabilities: { allow: ["kvfcu/sign_in@1", "kvfcu/transfer@1"] },
  });
  const merged = mergePolicy({ global: globalLayer, app, tenant, appName: "kvfcu" });
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
}): Promise<Ran> {
  const { root, remove } = await tempRoot("intyy-disc-");
  const evidence = new FileEvidenceStore({
    root: join(root, "evidence"),
    tmpDir: join(root, "tmp"),
  });
  const planner = opts.planner ?? new ScriptedPlanner(opts.steps ?? SIGN_IN_STEPS);
  const operator = new FakeOperator(opts.answers ?? []);
  const clock = new SteppingClock("2026-09-28T14:00:00.000Z");
  const result = await runDiscovery(
    {
      spec: opts.spec ?? SIGN_IN,
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
      ids: new SeededIds(clock),
      secrets: new MapSecrets(
        opts.secrets ?? {
          INTYY_KEYSTONE_KVFCU_OPERATOR_USERNAME: "teller-one",
          INTYY_KEYSTONE_KVFCU_OPERATOR_PASSWORD: PASSWORD,
        },
      ),
      surface: snapshotFactory(opts.site ?? SITE),
      marker: new FakeMarker(),
      planner,
      operator: () => operator,
    },
  );
  const ev = await evidence.events("keystone", result.runId);
  const events = ev.ok ? (ev.value as Record<string, unknown>[]) : [];
  const files = await readTree(join(root, "evidence", "keystone", "runs", result.runId));
  return { result, events, files, root, planner, operator, remove };
}

/** The event names, in order. */
export const names = (events: Record<string, unknown>[]): string[] =>
  events.map((e) => String(e.event));
