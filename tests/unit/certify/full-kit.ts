// Shared builders for the full-batch tests: certify deps on the fake site (a copy of
// `buildCertifyDeps` in runner.test.ts, with the harness made wrappable), a standard suite, and a
// profile set whose faults the double never fires, so each matrix run is a clean run judged
// against its rule. Not a test file. Design section 8 §7.2, §7.4. M10 task 3.
import type { CertifyDeps } from "../../../src/core/certify/runner.js";
import type { CertifyFullInput } from "../../../src/core/certify/full.js";
import type { FaultProfile } from "../../../src/core/model/faults.js";
import type { SuiteClass } from "../../../src/core/model/suite.js";
import type { TestInstance } from "../../../src/core/model/testdata.js";
import { FakeHarness } from "../../../src/fakes/harness.js";
import type { Harness } from "../../../src/ports/harness.js";
import { MEMBER_FOUND, MEMBER_MISSING, TENANT, buildHarness, fixtureSite } from "../replay/executor-harness.js";
import { idsNotifying, OPEN_SUB_ROUTE_FOR, RouteMappingHarness } from "./route-mapping-harness.js";

export const VALID: SuiteClass = { id: "valid", inputs: { member_id: "@members.valid" }, expect: { status: "success" } };
export const MISSING: SuiteClass = {
  id: "missing",
  inputs: { member_id: "@members.missing" },
  expect: { status: "business_outcome", outcome: "member_not_found" },
};
export const INSTANCE: TestInstance = { variant: "keystone", strip_semantics: false, drop_labels: 0, label_seed: "0" };

/** A profile with `recovers` on every placement, so a run the double never faults still matches it. */
export function profile(id: string, at: FaultProfile["at"], expectCommit: FaultProfile["expect_commit"] = "recovers"): FaultProfile {
  return { id, kind: "server_error", at, expect_commit: expectCommit, expect_window: "recovers" };
}

/** Everything one `runCertifyFull` call needs, built fresh. `wrap` swaps the harness for a wrapper. */
export async function fullDeps(
  site = fixtureSite(),
  over: Partial<CertifyDeps> = {},
  wrap: (h: RouteMappingHarness) => Harness = (h) => h,
) {
  const h = await buildHarness(site, over.models === undefined ? {} : { models: over.models });
  const route = new RouteMappingHarness(new FakeHarness(), h.deps.evidence, TENANT, OPEN_SUB_ROUTE_FOR);
  const ids = idsNotifying(h.deps.ids, route);
  const deps: CertifyDeps = {
    evidence: h.deps.evidence,
    clock: h.deps.clock,
    ids,
    secrets: h.deps.secrets,
    surface: h.deps.surface,
    artifacts: h.deps.artifacts,
    requestIndex: h.deps.requestIndex,
    harness: wrap(route),
    policy: h.policy,
    settings: h.settings,
    engineVersion: "0.1.0",
    ...over,
  };
  return { deps, ids, route };
}

/** A full-batch input with one valid class and three recovering profiles. `over` replaces any field. */
export function fullInput(batchId: string, over: Partial<CertifyFullInput> = {}): CertifyFullInput {
  return {
    batchId,
    tenant: TENANT,
    app: "kvfcu",
    capability: "open_sub",
    major: 1,
    appVersion: "8.4",
    staff: "op_017",
    className: "valid",
    classes: [VALID],
    pools: { "members.valid": [MEMBER_FOUND, MEMBER_FOUND, MEMBER_FOUND], "members.missing": [MEMBER_MISSING] },
    instance: INSTANCE,
    profiles: [
      profile("server_error", "@each_request_step"),
      profile("reply_lost", "@commit_point"),
      profile("slow_search", "@step:click_search"),
    ],
    matrixProfiles: "standard",
    extra: [],
    drills: 0,
    setup: [],
    ...over,
  };
}
