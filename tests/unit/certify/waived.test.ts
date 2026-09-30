// Proves certify's waived-artifact ending through `runCertifyCase` on the fake harness: when an
// artifact's recovery is a waiver, a commit-step fault passes by ending escalated at a
// `reconciliation_decision` (reason `reconciliation_waived`) with commit `uncertain`, and the
// report case is marked `waived`. A window-open case is judged as usual, with no flag. Two
// accounts in the oracle still fail commit truth. Design section 8 §6.3, §8.1 to §8.3; section 3
// §5.7, §5.12; docs/decisions.md, M06 (2026-09-30).
import { describe, expect, test } from "vitest";
import { runCertifyCase, type CertifyCaseInput, type CertifyDeps } from "../../../src/core/certify/runner.js";
import { Artifact } from "../../../src/core/model/artifact.js";
import { BatchReport } from "../../../src/core/model/batch-report.js";
import type { FaultProfile } from "../../../src/core/model/faults.js";
import type { SuiteClass } from "../../../src/core/model/suite.js";
import type { TestInstance } from "../../../src/core/model/testdata.js";
import { ok } from "../../../src/ports/outcome.js";
import { FakeHarness } from "../../../src/fakes/harness.js";
import type { Ids } from "../../../src/ports/clock.js";
import type { FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import {
  ACCOUNT_NUMBER,
  MEMBER_FOUND,
  OPEN_SUB,
  TENANT,
  buildHarness,
  fixtureSite,
} from "../replay/executor-harness.js";
import { idsNotifying, OPEN_SUB_ROUTE_FOR, RouteMappingHarness } from "./route-mapping-harness.js";

/** `open_sub` with a waiver, plus an optional `notes` input so commit truth can run (section 8
 * §8.2). The step list is unchanged. */
const OPEN_SUB_WAIVED = Artifact.parse({
  ...OPEN_SUB,
  identity: { ...OPEN_SUB.identity, capability: "open_sub_waived" },
  contract: {
    ...OPEN_SUB.contract,
    inputs: [
      ...OPEN_SUB.contract.inputs,
      { name: "notes", type: "string", description: "Free text", required: false, sensitivity: "none" },
    ],
  },
  recovery: { commit_point: "click_confirm", reconciliation: { waiver: { reason: "The app shows no screen to check." } } },
});

const VALID_CLASS: SuiteClass = {
  id: "valid",
  inputs: { member_id: "@members.valid", notes: "attempt {system.run_id}" },
  expect: { status: "success" },
};
const INSTANCE: TestInstance = { variant: "keystone", strip_semantics: false, drop_labels: 0, label_seed: "0" };

const COMMIT_PROFILE: FaultProfile = {
  id: "reply_lost",
  kind: "drop_after_confirm",
  at: "@commit_point",
  expect_commit: "reconciles_found",
  expect_window: "recovers",
};
const WINDOW_PROFILE: FaultProfile = {
  id: "server_error_on_search",
  kind: "server_error",
  at: "@step:click_search",
  expect_commit: "recovers",
  expect_window: "recovers",
};

/** A clean baseline, then a lost Confirm reply: the first visit to `/result` navigates on Confirm
 * (the baseline), every later one does nothing, so the checkpoint never shows and the commit ends
 * uncertain (section 2 §16.6). */
function siteLosingTheSecondReply(): FakeSite {
  const good = fixtureSite();
  const stuck = fixtureSite({ confirm: "stuck" });
  let visits = 0;
  return {
    ...good,
    screens: {
      ...good.screens,
      get "/result"() {
        visits += 1;
        return visits === 1 ? good.screens["/result"] : stuck.screens["/result"];
      },
    },
  } as FakeSite;
}

/** Fresh deps with the waived artifact sealed. `accounts` is how many accounts the oracle
 * reports for every attempt's own notes text. */
async function setup(site: ReturnType<typeof fixtureSite>, accounts: number) {
  const h = await buildHarness(site);
  const sealed = await h.deps.artifacts.seal("kvfcu/open_sub_waived/cand_2026-01-15_1000000006", "1.0.0", "op_017", OPEN_SUB_WAIVED, {});
  if (!sealed.ok) throw new Error("test setup: waived seal failed");
  const harness = new RouteMappingHarness(new FakeHarness(), h.deps.evidence, TENANT, OPEN_SUB_ROUTE_FOR);
  // Why: the double re-parses every run's log on each read. The case run's own log holds a
  // `reconciliation_decision` line, which the log-line schema does not know, so only the
  // baseline read (the route map's) may parse.
  const realLog = harness.faultLog.bind(harness);
  let reads = 0;
  harness.faultLog = async (signal) => (++reads === 1 ? realLog(signal) : ok([]));
  const notifying = idsNotifying(h.deps.ids, harness);
  // Why: the oracle answers by exact notes text, which holds the run ID, so seed it as each ID is minted.
  const ids: Ids = {
    ...notifying,
    runId: () => {
      const id = notifying.runId();
      harness.seedOracle(`attempt ${id}`, {
        exists: accounts > 0,
        count: accounts,
        accounts: Array.from({ length: accounts }, (_, i) => ({
          account_number: i === 0 ? ACCOUNT_NUMBER : `${ACCOUNT_NUMBER}${String(i)}`,
          status: "OPEN" as const,
          confirmation_number: `C00000${String(i)}`,
        })),
      });
      return id;
    },
  };
  const deps: CertifyDeps = {
    evidence: h.deps.evidence,
    clock: h.deps.clock,
    ids,
    secrets: h.deps.secrets,
    surface: h.deps.surface,
    artifacts: h.deps.artifacts,
    requestIndex: h.deps.requestIndex,
    harness,
    policy: h.policy,
    settings: h.settings,
    engineVersion: "0.1.0",
  };
  return { deps, ids };
}

function inputFor(batchId: string, profile: FaultProfile): CertifyCaseInput {
  return {
    batchId,
    tenant: TENANT,
    app: "kvfcu",
    capability: "open_sub_waived",
    major: 1,
    appVersion: "8.4",
    staff: "op_017",
    className: "valid",
    selection: { kind: "profile", profile },
    at: undefined,
    classes: [VALID_CLASS],
    pools: { "members.valid": [MEMBER_FOUND] },
    instance: INSTANCE,
  };
}

describe("runCertifyCase on a waived artifact", () => {
  test("a commit-step profile case: escalated at reconciliation_waived, commit uncertain, verdict pass, waived true", async () => {
    const { deps, ids } = await setup(siteLosingTheSecondReply(), 1);
    const result = await runCertifyCase(inputFor(ids.batchId(), COMMIT_PROFILE), deps);
    if (!result.ok) throw new Error(`expected ok, got ${result.failure}`);
    const c = result.value.report.cases[0];
    expect(BatchReport.safeParse(result.value.report).success).toBe(true);
    expect(c?.result).toEqual({
      status: "escalated",
      detail: "reconciliation_decision/reconciliation_waived/click_confirm",
    });
    expect(c?.truth.commit?.match).not.toBe(false);
    expect(c?.verdict).toBe("pass");
    expect(c?.waived).toBe(true);
    expect(result.value.report.gate.passed).toBe(true);
  });

  test("a window-open case: judged by expect_window as usual, with no waived flag", async () => {
    const { deps, ids } = await setup(fixtureSite(), 1);
    const result = await runCertifyCase(inputFor(ids.batchId(), WINDOW_PROFILE), deps);
    if (!result.ok) throw new Error(`expected ok, got ${result.failure}`);
    const c = result.value.report.cases[0];
    expect(c?.result).toEqual({ status: "success", detail: null });
    expect(c?.verdict).toBe("pass");
    expect(c).not.toHaveProperty("waived");
  });

  test("two accounts in the oracle: commit truth is wrong, so the case fails even with the waived ending", async () => {
    const { deps, ids } = await setup(siteLosingTheSecondReply(), 2);
    const result = await runCertifyCase(inputFor(ids.batchId(), COMMIT_PROFILE), deps);
    if (!result.ok) throw new Error(`expected ok, got ${result.failure}`);
    const c = result.value.report.cases[0];
    expect(c?.truth.commit?.match).toBe(false);
    expect(c?.verdict).toBe("wrong");
    expect(result.value.report.gate.passed).toBe(false);
  });
});
