// Proves certify understands a `count_diff` reconciliation check (owner decisions, 2026-10-01;
// design section 8 §6.3, §6.4; section 7 §11.1): `reconciles_found` on such an artifact expects
// failed `outputs_unavailable` with commit `found_by_check` (a count proves the commit but returns
// no outputs); every other rule and the `reference` mode are unchanged; a commit-step fault case
// through `runCertifyCase` passes with that ending; and the route map drops the baseline child's
// earlier requests while the parent's steps keep the right nth. Synthetic values only.
import { describe, expect, test } from "vitest";
import { runCertifyCase, type CertifyCaseInput, type CertifyDeps } from "../../../src/core/certify/runner.js";
import { buildRouteMap } from "../../../src/core/certify/route-map.js";
import { matchesExpectRule, type ResultClass } from "../../../src/core/certify/verdicts.js";
import { Artifact } from "../../../src/core/model/artifact.js";
import { BatchReport } from "../../../src/core/model/batch-report.js";
import type { ExpectRule, FaultProfile } from "../../../src/core/model/faults.js";
import type { SuiteClass } from "../../../src/core/model/suite.js";
import type { TestInstance } from "../../../src/core/model/testdata.js";
import type { CommitState } from "../../../src/core/model/result.js";
import { FakeHarness } from "../../../src/fakes/harness.js";
import type { FakeElement, FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import type { Ids } from "../../../src/ports/clock.js";
import type { FaultLogEntry, HarnessFailure, OracleAnswer } from "../../../src/ports/harness.js";
import { fail, type Outcome } from "../../../src/ports/outcome.js";
import { Secret } from "../../../src/ports/secret.js";
import {
  ACCOUNT_NUMBER,
  CHECK_SUB,
  MEMBER_FOUND,
  OPEN_SUB,
  TENANT,
  buildHarness,
  fixtureSite,
} from "../replay/executor-harness.js";
import { idsNotifying, OPEN_SUB_ROUTE_FOR, RouteMappingHarness } from "./route-mapping-harness.js";

const SUCCESS: ResultClass = { status: "success", detail: null };
const FAILED_NO_OUTPUTS: ResultClass = { status: "failed", detail: "outputs_unavailable" };
const FAILED_APP_ERROR: ResultClass = { status: "failed", detail: "app_error" };
const ESCALATED: ResultClass = { status: "escalated", detail: "takeover/stuck/click_confirm" };
const successExpect = { status: "success" };

describe("matchesExpectRule: reconciles_found with a count_diff check", () => {
  test("reconciles_found with a count_diff check needs failed outputs_unavailable and found_by_check", () => {
    // matches failed outputs_unavailable with commit found_by_check
    {
      expect(matchesExpectRule("reconciles_found", FAILED_NO_OUTPUTS, successExpect, "found_by_check", "count_diff")).toBe(true);
    }
    // does not match success with found_by_check
    {
      expect(matchesExpectRule("reconciles_found", SUCCESS, successExpect, "found_by_check", "count_diff")).toBe(false);
    }
    // does not match failed outputs_unavailable with any other commit state
    {
      for (const commit of ["uncertain", "confirmed", "absent_by_check", null] as const) {
        expect(matchesExpectRule("reconciles_found", FAILED_NO_OUTPUTS, successExpect, commit, "count_diff")).toBe(false);
      }
    }
    // does not match another failure code, even with found_by_check
    {
      expect(matchesExpectRule("reconciles_found", FAILED_APP_ERROR, successExpect, "found_by_check", "count_diff")).toBe(false);
    }
  });
});

describe("matchesExpectRule: reconciles_found in reference mode is unchanged", () => {
  test("in the default and reference modes, success with found_by_check matches and the failed ending does not", () => {
    for (const mode of [undefined, "reference" as const]) {
      expect(matchesExpectRule("reconciles_found", SUCCESS, successExpect, "found_by_check", mode), String(mode)).toBe(true);
      expect(matchesExpectRule("reconciles_found", FAILED_NO_OUTPUTS, successExpect, "found_by_check", mode), String(mode)).toBe(false);
    }
  });
});

describe("matchesExpectRule: the other rules answer the same in either mode", () => {
  const rules: ExpectRule[] = ["recovers", "recovers_or_escalates", "fails:app_error", "reconciles_absent"];
  const classes: ResultClass[] = [SUCCESS, FAILED_NO_OUTPUTS, FAILED_APP_ERROR, ESCALATED];
  const commits: (CommitState | null)[] = [null, "confirmed", "found_by_check", "uncertain"];

  test("each rule, class, and commit state answers the same in reference, count_diff, and default mode", () => {
    for (const rule of rules) {
      for (const rc of classes) {
        for (const commit of commits) {
          const label = `${rule} ${rc.status} ${String(commit)}`;
          const reference = matchesExpectRule(rule, rc, successExpect, commit, "reference");
          expect(matchesExpectRule(rule, rc, successExpect, commit, "count_diff"), label).toBe(reference);
          expect(matchesExpectRule(rule, rc, successExpect, commit), label).toBe(reference);
        }
      }
    }
  });
});

describe("buildRouteMap with a count_diff baseline child before the parent's first action", () => {
  const entry = (time: string, route: string, nth: number): FaultLogEntry => ({
    seq: nth,
    time,
    method: route.split(" ")[0] ?? "GET",
    path: route.split(" ")[1] ?? "/",
    route_count: nth,
    decision: "pass",
    fault_kind: null,
    block_point: "none",
    style: null,
    named_id: null,
    delay_ms: 0,
  });

  test("buildRouteMap drops a baseline child's earlier requests and keeps the parent's counters", () => {
    // the child's earlier requests are dropped; the parent's steps keep the counters that include them
    {
      // The baseline child signs in and reads first: two requests, nth 1, before any parent action.
      const actions = [
        { step: "session:click_login", at: "2026-01-15T09:00:10.000Z" },
        { step: "click_search", at: "2026-01-15T09:00:11.000Z" },
        { step: "click_confirm", at: "2026-01-15T09:00:12.000Z" },
      ];
      const log = [
        entry("2026-01-15T09:00:01.000Z", "POST /login", 1),
        entry("2026-01-15T09:00:02.000Z", "GET /subaccounts", 1),
        entry("2026-01-15T09:00:10.200Z", "POST /login", 2),
        entry("2026-01-15T09:00:11.200Z", "POST /search", 1),
        entry("2026-01-15T09:00:12.200Z", "POST /confirm", 1),
      ];
      const map = buildRouteMap(actions, log);
      expect([...map.keys()]).toEqual(["session:click_login", "click_search", "click_confirm"]);
      expect(map.get("session:click_login")).toEqual({ route: "POST /login", nth: 2 });
      expect(map.get("click_search")).toEqual({ route: "POST /search", nth: 1 });
      expect(map.get("click_confirm")).toEqual({ route: "POST /confirm", nth: 1 });
    }
    // a baseline child's request on a route the parent shares does not become the parent's first
    {
      const actions = [{ step: "click_search", at: "2026-01-15T09:00:11.000Z" }];
      const log = [
        entry("2026-01-15T09:00:02.000Z", "POST /search", 1),
        entry("2026-01-15T09:00:11.200Z", "POST /search", 2),
      ];
      expect(buildRouteMap(actions, log).get("click_search")).toEqual({ route: "POST /search", nth: 2 });
    }
  });
});

// ---- runner level: a lost Confirm reply on a count_diff artifact -------------------------------

/** A count read: integer output `subaccount_count`, no outcomes, only `check_shown`. */
const COUNT_SUB = Artifact.parse({
  ...CHECK_SUB,
  identity: { ...CHECK_SUB.identity, capability: "count_sub" },
  contract: {
    inputs: CHECK_SUB.contract.inputs,
    outputs: [{ name: "subaccount_count", type: "integer", description: "How many sub-accounts the member has", sensitivity: "financial" }],
    outcomes: [],
    effect: "read_only",
  },
  targets: [{ id: "subaccount_count_display", description: "The sub-account count", clues: { role: "generic", label: "Sub-account count" } }],
  conditions: CHECK_SUB.conditions.filter((c) => c.id === "check_shown"),
  steps: [
    {
      id: "read_count",
      intent: "Read the sub-account count",
      action: { type: "read", target: "subaccount_count_display", source: "text", output: "subaccount_count" },
      precondition: "check_shown",
      checkpoint: "check_shown",
      outcomes: [],
      risk: "idempotent",
      timeout_ms: 5000,
    },
  ],
});

/** `open_sub` (plus a `notes` input so commit truth can run) with a `count_diff` check. */
const OPEN_SUB_COUNT = Artifact.parse({
  ...OPEN_SUB,
  identity: { ...OPEN_SUB.identity, capability: "open_sub_count" },
  contract: {
    ...OPEN_SUB.contract,
    inputs: [
      ...OPEN_SUB.contract.inputs,
      { name: "notes", type: "string", description: "Free text", required: false, sensitivity: "none" },
    ],
  },
  recovery: {
    commit_point: "click_confirm",
    reconciliation: {
      check: {
        capability: "kvfcu/count_sub@1",
        mode: "count_diff",
        count_output: "subaccount_count",
        inputs: { member_id: "{input.member_id}" },
        not_found_outcomes: [],
        outputs: {},
      },
    },
  },
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

/**
 * The fixture flow plus a counting `/check`. Confirm works on the first visit to `/result` (the
 * clean baseline run) and does nothing after (the lost reply). The n-th visit to `/check` shows
 * `counts[n]`: the baseline run's own baseline child, then the case run's baseline child, then its
 * check child.
 */
function siteCounting(counts: readonly number[]): FakeSite {
  const good = fixtureSite();
  const stuck = fixtureSite({ confirm: "stuck" });
  let results = 0;
  let checks = 0;
  return {
    ...good,
    screens: {
      ...good.screens,
      get "/result"() {
        results += 1;
        return results === 1 ? good.screens["/result"] : stuck.screens["/result"];
      },
      get "/check"() {
        const n = counts[Math.min(checks, counts.length - 1)] ?? 0;
        checks += 1;
        const shown: FakeElement = { id: "subaccount_count_display", role: "generic", roleGroup: "container", label: "Sub-account count", text: String(n) };
        return { elements: [shown] };
      },
    },
  } as FakeSite;
}

/** A harness whose oracle read fails for one exact notes text (an unreachable app on that attempt). */
class OracleFailingHarness extends RouteMappingHarness {
  failFor: string | null = null;
  override oracle(notes: Secret): Promise<Outcome<OracleAnswer, HarnessFailure>> {
    if (this.failFor !== null && Secret.open(notes) === this.failFor) return Promise.resolve(fail("unreachable"));
    return super.oracle(notes);
  }
}

/**
 * `unsent` names the n-th run IDs minted (1-based) whose attempt the oracle must answer "no account" for.
 * `accountOf` gives an attempt another account number than the fixture's. `failRead` names the n-th run ID
 * whose oracle read fails.
 */
async function setup(
  site: FakeSite,
  unsent: number | readonly number[] | null = null,
  opts: { accountOf?: Readonly<Record<number, string>>; failRead?: number } = {},
) {
  const unsentList = unsent === null ? [] : typeof unsent === "number" ? [unsent] : unsent;
  const h = await buildHarness(site);
  for (const [name, art, n] of [["count_sub", COUNT_SUB, "1000000031"], ["open_sub_count", OPEN_SUB_COUNT, "1000000032"]] as const) {
    const sealed = await h.deps.artifacts.seal(`kvfcu/${name}/cand_2026-01-15_${n}`, "1.0.0", "op_017", art, {});
    if (!sealed.ok) throw new Error(`test setup: ${name} seal failed`);
  }
  const harness = new OracleFailingHarness(new FakeHarness(), h.deps.evidence, TENANT, OPEN_SUB_ROUTE_FOR);
  const notifying = idsNotifying(h.deps.ids, harness);
  // Why: the oracle answers by the attempt's exact notes text, which holds the run ID.
  let minted = 0;
  const ids: Ids = {
    ...notifying,
    runId: () => {
      const id = notifying.runId();
      minted += 1;
      if (minted === opts.failRead) harness.failFor = `attempt ${id}`;
      if (unsentList.includes(minted)) return id;
      harness.seedOracle(`attempt ${id}`, {
        exists: true,
        count: 1,
        accounts: [{ account_number: opts.accountOf?.[minted] ?? ACCOUNT_NUMBER, status: "OPEN" as const, confirmation_number: "C000000" }],
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
  return { deps, ids, harness };
}

function inputFor(batchId: string): CertifyCaseInput {
  return {
    batchId,
    tenant: TENANT,
    app: "kvfcu",
    capability: "open_sub_count",
    major: 1,
    appVersion: "8.4",
    staff: "op_017",
    className: "valid",
    selection: { kind: "profile", profile: COMMIT_PROFILE },
    at: undefined,
    classes: [VALID_CLASS],
    pools: { "members.valid": [MEMBER_FOUND] },
    instance: INSTANCE,
  };
}

describe("runCertifyCase on a count_diff artifact (M05 gate row: count_diff found)", () => {
  test("a lost Confirm reply: the count rose by one, so the case ends failed outputs_unavailable, found_by_check, and passes", async () => {
    const { deps, ids } = await setup(siteCounting([2, 2, 3]));
    const result = await runCertifyCase(inputFor(ids.batchId()), deps);
    if (!result.ok) throw new Error(`expected ok, got ${result.failure}`);
    const c = result.value.report.cases[0];
    expect(BatchReport.safeParse(result.value.report).success).toBe(true);
    expect(c?.result).toEqual({ status: "failed", detail: "outputs_unavailable" });
    expect(c?.truth.commit?.match).not.toBe(false);
    expect(c?.verdict).toBe("pass");
    expect(result.value.report.gate.passed).toBe(true);
  });
});

/**
 * Like `siteCounting`, but a retry can work: Confirm succeeds on the clean baseline run, is lost for
 * the case run's first attempt, and works again once the check child has read (visit 3 of `/check`).
 */
function siteCountingRetryWorks(counts: readonly number[]): FakeSite {
  const base = siteCounting(counts);
  const good = fixtureSite();
  const stuck = fixtureSite({ confirm: "stuck" });
  let results = 0;
  let checks = 0;
  return {
    ...base,
    screens: {
      ...base.screens,
      get "/result"() {
        results += 1;
        return results === 1 || checks >= 3 ? good.screens["/result"] : stuck.screens["/result"];
      },
      get "/check"() {
        const n = counts[Math.min(checks, counts.length - 1)] ?? 0;
        checks += 1;
        const shown: FakeElement = { id: "subaccount_count_display", role: "generic", roleGroup: "container", label: "Sub-account count", text: String(n) };
        return { elements: [shown] };
      },
    },
  } as FakeSite;
}

describe("runCertifyCase on a count_diff artifact: the count stays the same (absent), the scripted operator retries", () => {
  // Why this case: the first attempt's authorization is certify's synthetic 30 minutes, and the
  // fake clock's waits (the 15 s commit wait, the retry decision) move past it before the retry
  // commits. The retry must reach its commit point and ask a person (the script approves), not be
  // rejected for the expired authorization (design section 7 §11.3, section 3 §4.6).
  /**
   * Run IDs, in order: 1 clean run, 2 its baseline child, 3 the case run (its Confirm is lost and
   * nothing was sent, so the oracle knows no account for it), 4 its baseline child, 5 its check
   * child, 6 the retry (its own account exists), 7 the retry's baseline child.
   */
  async function lostThenRetried(unsent: number | readonly number[] | null = 3, opts: Parameters<typeof setup>[2] = {}) {
    const { deps, ids } = await setup(siteCountingRetryWorks([2, 2, 2, 2, 2]), unsent, opts);
    const profile: FaultProfile = { ...COMMIT_PROFILE, id: "reply_lost_absent", expect_commit: "reconciles_absent" };
    const result = await runCertifyCase({ ...inputFor(ids.batchId()), selection: { kind: "profile", profile } }, deps);
    if (!result.ok) throw new Error(`expected ok, got ${result.failure}`);
    return { deps, report: result.value.report, c: result.value.report.cases[0] };
  }

  test("the retry reaches its commit point and a person approves: success, not failed and not rejected", async () => {
    const { deps, report, c } = await lostThenRetried();

    expect(BatchReport.safeParse(report).success).toBe(true);
    expect(c?.result).toEqual({ status: "success", detail: null });
    // The retry's authorization had ended by its commit point, so the gate asked, and the script approved.
    let retryGates: unknown[] = [];
    for (const id of await deps.evidence.listRuns(TENANT)) {
      const e = await deps.evidence.events(TENANT, id);
      if (!e.ok) continue;
      const lines = e.value as { event: string; data: Record<string, unknown> }[];
      if (lines.find((l) => l.event === "run_start")?.data.purpose !== "commit_retry") continue;
      retryGates = lines.filter((l) => l.event === "gate" && l.data.risk === "irreversible").map((l) => l.data.decision);
    }
    expect(retryGates).toEqual(["needs_approval", "allowed"]);
  });

  test("commit truth is per attempt (section 8 §8.2): first attempt absent, the retry's own account exists, so the case passes", async () => {
    const { report, c } = await lostThenRetried();

    // The retry's account (its own run ID) is the one that exists; the case run's ID has none.
    expect(c?.truth.commit).toMatchObject({ match: true });
    expect(c?.verdict).toBe("pass");
    expect(report.gate.passed).toBe(true);
  });

  test("two accounts across the attempts: the case is wrong, though each attempt alone looks plausible", async () => {
    // Run 3 (first attempt) holds an account although the case run reported nothing sent; run 6 (retry) holds one too.
    const { c } = await lostThenRetried(null);

    expect(c?.truth.commit?.match).toBe(false);
    expect(c?.verdict).toBe("wrong");
  });

  test("the retry reports confirmed but the oracle has no account for its own run ID: wrong", async () => {
    // Neither run 3 nor run 6 holds an account. The first attempt (absent_by_check, count 0) is fine; the retry's claim is not.
    const { c } = await lostThenRetried([3, 6]);

    expect(c?.result).toEqual({ status: "success", detail: null });
    expect(c?.truth.commit?.match).toBe(false);
    expect(c?.verdict).toBe("wrong");
  });

  test("an oracle read that fails for one attempt leaves commit truth unset, and the case is not wrong", async () => {
    const { c } = await lostThenRetried(3, { failRead: 6 });

    expect(c?.truth.commit).toBeUndefined();
    expect(c?.verdict).not.toBe("wrong");
  });

  test("a failed read of the first attempt also leaves commit truth unset", async () => {
    const { c } = await lostThenRetried(3, { failRead: 3 });

    expect(c?.truth.commit).toBeUndefined();
    expect(c?.verdict).not.toBe("wrong");
  });

  test("output truth uses the last attempt's account (section 8 §8.2)", async () => {
    // The first attempt's account has another number; only the retry's account matches the page the retry read.
    const { c } = await lostThenRetried(null, { accountOf: { 3: "ZZ0000000" } });
    expect(c?.result).toEqual({ status: "success", detail: null });
    expect(c?.truth.output).toEqual({ match: true });

    // With no account for the retry's ID, the first attempt's account is no stand-in: nothing to compare.
    const none = await lostThenRetried([6], { accountOf: { 3: "ZZ0000000" } });
    expect(none.c?.truth.output?.match).toBeNull();
  });
});

describe("runCertifyCase on a count_diff artifact: a case without a retry judges one attempt, by the case run's ID", () => {
  test("the lost reply found by the count: the case run's own account exists, so commit truth matches", async () => {
    const { deps, ids } = await setup(siteCounting([2, 2, 3]));
    const result = await runCertifyCase(inputFor(ids.batchId()), deps);
    if (!result.ok) throw new Error(`expected ok, got ${result.failure}`);
    expect(result.value.report.cases[0]?.truth.commit).toEqual({ match: true });
  });

  test("with no account under the case run's ID, found_by_check does not match", async () => {
    // Run 3 is the case run (1 clean run, 2 its baseline child).
    const { deps, ids } = await setup(siteCounting([2, 2, 3]), 3);
    const result = await runCertifyCase(inputFor(ids.batchId()), deps);
    if (!result.ok) throw new Error(`expected ok, got ${result.failure}`);
    expect(result.value.report.cases[0]?.truth.commit?.match).toBe(false);
  });
});
