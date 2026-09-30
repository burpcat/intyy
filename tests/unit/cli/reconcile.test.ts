// Proves `intyy reconcile` end to end (design section 9 §10.6; docs/decisions.md M06): matching
// inputs write `effect_update.json` and `run status` warns `effect_updated`; mismatched inputs
// against a live index entry are refused, nothing written; no request ID warns and reads a note
// from standard input; the operator role is required. Seeds the parent run's `run.json` and
// request-index entry directly (mirrors `operator.test.ts`'s own `root()`): driving a live,
// off-terminal run all the way to an unanswered escalation is `takeover.test.ts`'s and
// `reconciliation.test.ts`'s job, at the executor level. M06 task 5.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { Result } from "../../../src/core/model/result.js";
import { Request as RequestSchema } from "../../../src/core/model/request.js";
import { recordRequestIndex } from "../../../src/core/orchestrator/request-index.js";
import { SystemClock } from "../../../src/adapters/system/clock.js";
import { MapSecrets } from "../../../src/fakes/secrets.js";
import type { FakeElement, FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { cleanRoots } from "./helpers.js";
import { ORIGIN, realWiringOf, replayCall, replayRoot, type ReplayEnv } from "./replay-harness.js";

afterAll(cleanRoots);

const RUN = "run_2026-01-15_7kq2m9x4tb";
const REQUEST_INDEX_ENV = "INTYY_KEYSTONE_REQUEST_INDEX_KEY_K1";
const REQUEST_INDEX_KEY_VALUE = "test-request-index-key";

/** `check_sub`'s own `/check` screen, showing the account found. Only `intyy reconcile`'s own
 * check-capability child ever visits it here: the parent run itself is seeded directly, never
 * driven live (see the file header). */
function siteWithFoundCheck(): FakeSite {
  const display: FakeElement = { id: "account_number_display", role: "generic", roleGroup: "container", label: "Account number", text: "SH7654321" };
  return { origin: ORIGIN, screens: { "/check": { elements: [display] } } };
}

/** One `run.json`, `status: "failed"`, commit `uncertain` (design section 9 §10.6's own "when":
 * a run final with an uncertain commit). `requestId` drives which of `reconcile`'s own input
 * checks applies (section 9 §10.6 steps 2 and 3). */
function seededRun(requestId: string | null): unknown {
  const result = Result.parse({
    schema: "intyy.result/1.0",
    run_id: RUN,
    request_id: requestId,
    capability: { name: "kvfcu/open_sub_checked", version: "1.0.0", patch_revision: null },
    warnings: [],
    recoveries: [],
    interventions: [],
    timing: { started_at: "2026-01-15T09:00:00.000Z", ended_at: "2026-01-15T09:05:00.000Z", duration_ms: 300_000, human_ms: 0 },
    evidence: `runs/${RUN}`,
    status: "failed",
    effect: { commit: "uncertain", performed_by: "bot", sent_at: "2026-01-15T09:04:00.000Z", attempts: [] },
    failure: {
      code: "escalation_timeout",
      message: "the reconciliation decision timed out",
      step: "click_confirm",
      phase: "escalation",
      expected: { condition: "escalation", description: "the reconciliation decision timed out" },
      observed: { location: "http://127.0.0.1:9196/result", checks: [] },
      attempts: 0,
      ladder: { rung: 4, verdict: "needs_human", ref: "reconciliation_unclear" },
      transient: true,
      safe_to_retry: false,
      files: [],
    },
  });
  return {
    schema: "intyy.run/1.0",
    run_id: RUN,
    tenant: "keystone",
    kind: "replay",
    capability: "kvfcu/open_sub_checked",
    parent_run_id: null,
    batch_id: null,
    request_id: requestId,
    status: "failed",
    result,
    frozen: {
      mode: "supervised",
      authorization: { consent_ref: "consent_1" },
      frozen: { app_version: "8.4" },
    },
    files: [],
    retention: { debug_until: "2026-02-14", audit_until: "2027-01-15" },
  };
}

/** Writes `seededRun`'s own run.json into `env`'s real, file-backed evidence store. */
async function seedRun(env: ReplayEnv, requestId: string | null): Promise<void> {
  const wiring = realWiringOf(env);
  const created = await wiring.evidence.createRun("keystone", RUN);
  if (!created.ok) throw new Error(`test setup: createRun failed: ${created.failure}`);
  const written = await created.value.writeRunJson(seededRun(requestId) as never);
  if (!written.ok) throw new Error("test setup: writeRunJson failed");
}

/** Records a request-index entry a matching `intyy reconcile` call will find. `reconcile.ts`
 * always looks up under agent ID `"reconcile"` (its own call), whatever agent ran the original
 * request. */
async function seedIndexEntry(env: ReplayEnv, requestId: string, memberId: string): Promise<void> {
  const wiring = realWiringOf(env);
  // Why a cast, not `RequestSchema.parse`: `reconcile.ts`'s own synthetic request (the one this
  // must hash the same as) is built the same way — a partial `authorization`, since a manual
  // reconcile has no full block to rebuild, only the reference it hashed (section 9 §10.6;
  // `contentSubject` only ever reads `authorization?.consent_ref`).
  const request = {
    schema: "intyy.request/1.0",
    request_id: requestId,
    capability: "kvfcu/open_sub_checked@1",
    inputs: { member_id: memberId },
    mode: "supervised",
    authorization: { consent_ref: "consent_1" },
  } as unknown as ReturnType<typeof RequestSchema.parse>;
  const deps = {
    store: wiring.requestIndexStore,
    clock: new SystemClock(),
    secrets: new MapSecrets({ [REQUEST_INDEX_ENV]: REQUEST_INDEX_KEY_VALUE }),
    keys: [{ keyId: "k1", status: "current" as const, binding: { source: "env" as const, key: REQUEST_INDEX_ENV } }],
  };
  const recorded = await recordRequestIndex(deps, "keystone", "reconcile", request, RUN);
  if (!recorded.ok) throw new Error(`test setup: recordRequestIndex failed: ${recorded.failure}`);
}

const effectUpdatePath = (env: ReplayEnv) => join(env.root, "state", "evidence", "keystone", "runs", RUN, "effect_update.json");

describe("intyy reconcile: no request ID (section 9 §10.6, docs/decisions.md M06)", () => {
  test("warns, reads a note from standard input, and still writes effect_update.json", async () => {
    const env = await replayRoot();
    await seedRun(env, null);
    const inputs = join(env.root, "reconcile-inputs.json");
    writeFileSync(inputs, JSON.stringify({ member_id: "700114" }));

    const rec = await replayCall(env, ["reconcile", RUN, "--inputs", inputs, "--json"], {
      site: siteWithFoundCheck(),
      answers: ["found on the second look"],
    });

    expect(rec.code).toBe(0);
    expect(rec.stderr).toContain("no request ID was recorded");
    const data = JSON.parse(rec.stdout) as { finding: string };
    expect(data.finding).toBe("found_by_check");
    expect(existsSync(effectUpdatePath(env))).toBe(true);
    expect(JSON.parse(readFileSync(effectUpdatePath(env), "utf8"))).toMatchObject({
      schema: "intyy.effect_update/1.0",
      parent_run_id: RUN,
      finding: "found_by_check",
    });
  });
});

describe("intyy reconcile: matching inputs against a live index entry (section 9 §10.6)", () => {
  test("writes effect_update.json; run status then warns effect_updated", async () => {
    const env = await replayRoot();
    await seedRun(env, "req-000001");
    await seedIndexEntry(env, "req-000001", "700114");
    const inputs = join(env.root, "reconcile-inputs.json");
    writeFileSync(inputs, JSON.stringify({ member_id: "700114" }));

    const rec = await replayCall(env, ["reconcile", RUN, "--inputs", inputs, "--json"], { site: siteWithFoundCheck() });
    expect(rec.code).toBe(0);
    expect(existsSync(effectUpdatePath(env))).toBe(true);

    const status = await replayCall(env, ["run", "status", RUN, "--json"]);
    expect(status.code).toBe(5);
    const data = JSON.parse(status.stdout) as Result;
    expect(data.warnings.some((w) => w.code === "effect_updated")).toBe(true);
  });
});

describe("intyy reconcile: mismatched inputs against a live index entry (section 9 §10.6)", () => {
  test("refuses, and writes nothing", async () => {
    const env = await replayRoot();
    await seedRun(env, "req-000002");
    await seedIndexEntry(env, "req-000002", "700114");
    const inputs = join(env.root, "reconcile-inputs-wrong.json");
    writeFileSync(inputs, JSON.stringify({ member_id: "700199" }));

    const rec = await replayCall(env, ["reconcile", RUN, "--inputs", inputs]);
    expect(rec.code).toBe(6);
    expect(existsSync(effectUpdatePath(env))).toBe(false);
  });
});

describe("intyy reconcile: the operator role is required", () => {
  test("a staff ID without the operator role is refused", async () => {
    const env = await replayRoot();
    await seedRun(env, null);
    const inputs = join(env.root, "reconcile-inputs.json");
    writeFileSync(inputs, JSON.stringify({ member_id: "700114" }));

    // op_031 holds only "approver" for keystone (tests/unit/cli/helpers.ts's STAFF fixture).
    const rec = await replayCall(env, ["reconcile", RUN, "--inputs", inputs], { env: { INTYY_STAFF: "op_031" }, answers: ["n/a"] });
    expect(rec.code).toBe(6);
    expect(existsSync(effectUpdatePath(env))).toBe(false);
  });
});
