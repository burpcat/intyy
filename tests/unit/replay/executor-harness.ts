// Shared test harness for the replay executor: a merged policy, bank settings, the two sealed
// fixture artifacts, and a fresh set of in-memory ports per run. Not a test file itself: no
// `describe`/`test` here. Follows design section 7 §4 (a run, start to end); M05 task 8.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Artifact as ArtifactSchema, type Artifact } from "../../../src/core/model/artifact.js";
import { CandidateDecision, type CandidateDecision as CandidateDecisionT } from "../../../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../../../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../../../src/core/model/candidate-runs.js";
import type { CandidateFiles } from "../../../src/core/recorder/candidates.js";
import { sha256Hex } from "../../../src/core/model/canonical.js";
import { AppPolicy, GlobalPolicy, TenantPolicy } from "../../../src/core/model/policy.js";
import { Request as RequestSchema, type Request } from "../../../src/core/model/request.js";
import { RequestIndexLine } from "../../../src/core/model/request-index.js";
import { Settings } from "../../../src/core/model/settings.js";
import type { ReplayDeps, ReplayInput } from "../../../src/core/replay/executor.js";
import { mergePolicy, type MergeResult } from "../../../src/core/safety/policy/merge.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { SeededIds } from "../../../src/fakes/ids.js";
import { FakeOperator } from "../../../src/fakes/operator.js";
import { MapSecrets } from "../../../src/fakes/secrets.js";
import { snapshotFactory, type FakeElement, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { FakeCandidateStore, FakeEvidenceStore, FakeLogStore } from "../../../src/fakes/stores.js";

/** The fake app's origin: loopback, like every test host. */
export const ORIGIN = "http://127.0.0.1:9196";
export const TENANT = "keystone";
export const AGENT = "agent_teller_01";
/** `kvfcu/open_sub@1`'s two synthetic members. Neither is the canary member (CLAUDE.md). */
export const MEMBER_FOUND = "700114";
export const MEMBER_MISSING = "700199";

/** Reads one fixture file under `tests/fixtures/replay/`. */
function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../fixtures/replay/${name}`, import.meta.url), "utf8"));
}

/** Parses a fixture through the real `intyy.artifact/1.0` schema, so a shape mistake fails here. */
function parsedArtifact(name: string): Artifact {
  const parsed = ArtifactSchema.safeParse(readFixture(name));
  if (!parsed.success) throw new Error(`${name} does not fit intyy.artifact/1.0: ${parsed.error.message}`);
  return parsed.data;
}

/** The session artifact: read-only, entry `/`, one click step to `/home`. */
export const SIGN_IN = parsedArtifact("sign_in.json");
/** The task artifact: commits, links `kvfcu/sign_in@1`, entry `/home`. No reconciliation check
 * (`recovery.reconciliation` is `null`): M06's own "no check at all" case. */
export const OPEN_SUB = parsedArtifact("open_sub.json");
/** Same task, but linked to a real reconciliation check (section 7 §11), `kvfcu/check_sub@1`. */
export const OPEN_SUB_CHECKED = parsedArtifact("open_sub_checked.json");
/** The reconciliation check capability `open_sub_checked` links: read-only, entry `/check`. */
export const CHECK_SUB = parsedArtifact("check_sub.json");

const globalLayer = GlobalPolicy.parse(
  JSON.parse(readFileSync(new URL("../../../library/policy/global/1.json", import.meta.url), "utf8")),
);

/** A merged policy allowing exactly the fixture site's paths, and both capabilities. */
function policy(): MergeResult {
  const app = AppPolicy.parse({
    schema: "intyy.policy/1.0",
    scope: { level: "app", app: "kvfcu" },
    revision: 1,
    reason: "Test policy.",
    paths: { allow: ["/", "/home", "/result", "/done", "/check"], case_sensitive: true },
    secrets: {},
  });
  const tenant = TenantPolicy.parse({
    schema: "intyy.policy/1.0",
    scope: { level: "tenant", tenant: TENANT },
    revision: 1,
    reason: "Test policy.",
    capabilities: { allow: ["kvfcu/*@1"] },
  });
  const merged = mergePolicy({ global: globalLayer, app, tenant, appName: "kvfcu" });
  if (!merged.ok) throw new Error(`test policy does not merge: ${merged.detail ?? ""}`);
  return merged.value;
}

/** Bank settings for `kvfcu`, pointing at the fixture site's origin. */
function settingsDoc(): Settings {
  const parsed = Settings.safeParse({
    schema: "intyy.settings/1.0",
    tenant: TENANT,
    revision: 1,
    apps: {
      kvfcu: {
        origin: ORIGIN,
        app_version: "8.4",
        environment: "test",
        locale: "en-US",
        time_zone: "America/New_York",
        extra_origins: [],
        secrets: {},
      },
    },
  });
  if (!parsed.success) throw new Error("test settings do not fit intyy.settings/1.0");
  return parsed.data;
}

function newArtifactStore(): FakeCandidateStore<CandidateFiles, CandidateDecisionT> {
  return new FakeCandidateStore(
    {
      files: { "runs.json": CandidateRuns, "candidate.json": ArtifactSchema, "issues.json": CandidateIssues },
      decision: CandidateDecision,
    },
    new SteppingClock(),
  );
}

/** Everything one `runReplay` call needs, freshly built. `overrides` replaces any `ReplayDeps`
 * field, such as `clock` or `evidence`, for a test that wraps one of them. */
export async function buildHarness(
  site: FakeSite,
  overrides: Partial<ReplayDeps> = {},
): Promise<{ policy: MergeResult; settings: { doc: Settings; rev: string; hash: string }; deps: ReplayDeps }> {
  const store = newArtifactStore();
  await store.seal("kvfcu/sign_in/cand_2026-01-15_1000000001", "1.0.0", "op_017", SIGN_IN, {});
  await store.seal("kvfcu/open_sub/cand_2026-01-15_1000000002", "1.0.0", "op_017", OPEN_SUB, {});
  await store.seal("kvfcu/check_sub/cand_2026-01-15_1000000003", "1.0.0", "op_017", CHECK_SUB, {});
  await store.seal("kvfcu/open_sub_checked/cand_2026-01-15_1000000004", "1.0.0", "op_017", OPEN_SUB_CHECKED, {});
  const clock = new SteppingClock();
  const deps: ReplayDeps = {
    evidence: new FakeEvidenceStore(),
    clock,
    ids: new SeededIds(clock, 7),
    secrets: new MapSecrets({}),
    surface: snapshotFactory(site),
    artifacts: store,
    requestIndex: {
      store: new FakeLogStore({ line: RequestIndexLine, record: z.never() }),
      clock,
      secrets: new MapSecrets({ K1: "request-index-key" }),
      keys: [{ keyId: "k1", status: "current" as const, binding: { source: "env" as const, key: "K1" } }],
    },
    operator: () => new FakeOperator([]),
    ...overrides,
  };
  return { policy: policy(), settings: { doc: settingsDoc(), rev: "1", hash: `sha256:${sha256Hex("test-settings")}` }, deps };
}

/** One `intyy.request/1.0`, parsed through its real schema. */
export function requestOf(overrides: Record<string, unknown> = {}): Request {
  const raw = {
    schema: "intyy.request/1.0",
    request_id: null,
    capability: "kvfcu/open_sub@1",
    inputs: { member_id: MEMBER_FOUND },
    mode: "supervised",
    ...overrides,
  };
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`test request does not fit intyy.request/1.0: ${parsed.error.message}`);
  return parsed.data;
}

/** A valid authorization for `capability`, granted just before the clock's default start
 * (2026-01-15T09:00:00.000Z) and expiring well inside it (section 3 §4.6, global policy's
 * 30-minute default lifetime cap). */
export function authorizationFor(capability: string): Record<string, unknown> {
  return {
    consent_ref: "consent_1",
    granted_by: "member",
    granted_at: "2026-01-15T08:50:00.000Z",
    expires_at: "2026-01-15T09:20:00.000Z",
    capability,
  };
}

/** A `ReplayInput`, defaulted from `h`. `overrides` replaces any field, such as `runId`. */
export function replayInputOf(
  h: { policy: MergeResult; settings: { doc: Settings; rev: string; hash: string }; deps: ReplayDeps },
  request: Request,
  overrides: Partial<ReplayInput> = {},
): ReplayInput {
  return {
    runId: h.deps.ids.runId(),
    request,
    tenant: TENANT,
    agentId: AGENT,
    policy: h.policy,
    settings: h.settings,
    appVersion: "8.4",
    engineVersion: "0.1.0",
    outputsRevealed: true,
    visible: false,
    ...overrides,
  };
}

/** The account number the "/done" screen shows. Synthetic, matches no real bank format. */
export const ACCOUNT_NUMBER = "SH1234567";

/** What one fixture site variant looks like. Every screen stays at the same three paths;
 * only the elements on them change, per test. */
export type SiteOpts = {
  /** Home is missing its Member ID box: `type_member_id`'s target never resolves. Its own
   * precondition, `home_shown`, is a bare `location` check, so M06's rule makes this climb
   * rather than fail (docs/decisions.md, M06). */
  homeMissingBox?: boolean;
  /** Home is missing its Search button: `click_search`'s target never resolves. Its own
   * precondition, `member_id_entered`, is a `field_value` check, not location-only, so it still
   * ends `target_not_found` after retries (docs/decisions.md, M06's own carve-out). */
  homeMissingSearchButton?: boolean;
  /** "found" shows Confirm on `/result`; "not_found" shows the declared-outcome text instead. */
  result?: "found" | "not_found";
  /** Confirm's click goes to `/done` normally; "stuck" makes it do nothing (case 9). */
  confirm?: "navigates" | "stuck";
};

/** The scripted site behind both artifacts: sign_in's `/`, then open_sub's `/home`, `/result`,
 * and `/done`. One `runReplay` call opens it once; each open gets a fresh browser (M02). */
export function fixtureSite(opts: SiteOpts = {}): FakeSite {
  const result = opts.result ?? "found";
  const confirm = opts.confirm ?? "navigates";

  const homeElements: FakeElement[] = [];
  if (opts.homeMissingBox !== true) {
    homeElements.push({
      id: "member_id_box",
      role: "textbox",
      roleGroup: "text_entry",
      label: "Member ID",
      field: { kind: "text", value: "" },
    });
  }
  if (opts.homeMissingSearchButton !== true) {
    homeElements.push({
      id: "search_button",
      role: "button",
      roleGroup: "button_like",
      name: "Search",
      text: "Search",
      onClick: { go: "/result" },
    });
  }

  const resultElements: FakeElement[] =
    result === "found"
      ? [
          {
            id: "confirm_button",
            role: "button",
            roleGroup: "button_like",
            name: "Confirm",
            text: "Confirm",
            ...(confirm === "navigates" ? { onClick: { go: "/done" } as const } : {}),
          },
        ]
      : [{ id: "not_found_text", role: "generic", roleGroup: "container", text: "No member found" }];

  return {
    origin: ORIGIN,
    screens: {
      "/": {
        elements: [
          { id: "login_button", role: "button", roleGroup: "button_like", name: "Login", text: "Login", onClick: { go: "/home" } },
        ],
      },
      "/home": { elements: homeElements },
      "/result": { elements: resultElements },
      "/done": {
        elements: [
          { id: "account_number_display", role: "generic", roleGroup: "container", label: "Account number", text: ACCOUNT_NUMBER },
        ],
      },
    },
  };
}
