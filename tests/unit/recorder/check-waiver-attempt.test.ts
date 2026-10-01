// Proves `checkWaiverAttempt` against the fake evidence store: a waiver value must be JSON whose
// `attempt_run` is a well-formed run ID naming a discovery run in the tenant's store that did not
// end `success`. Every refusal is `invalid` with a detail that names attempt_run. Design section 2
// §16.3; docs/decisions.md, M05 (2026-10-01: a waiver cites its failed attempt). Synthetic values.
import { describe, expect, test } from "vitest";
import { checkWaiverAttempt } from "../../../src/core/recorder/candidates.js";
import type { Masked } from "../../../src/ports/masked.js";
import type { Outcome } from "../../../src/ports/outcome.js";
import { FakeEvidenceStore } from "../../../src/fakes/stores.js";

const TENANT = "keystone";
const REPLAY_RUN = "run_2026-10-01_0000000002";
const UNKNOWN_RUN = "run_2026-10-01_0000000009";

/** Test data holds no secret, so it counts as masked. */
const masked = <T,>(v: T): Masked<T> => v as Masked<T>;

const discovery = (runId: string, status: string) => ({
  schema: "intyy.run/1.0",
  run_id: runId,
  tenant: TENANT,
  kind: "discovery",
  capability: "kvfcu/open_share_subaccount",
  status,
  code: null,
  started_at: "2026-10-01T10:00:00.000Z",
  ended_at: "2026-10-01T10:00:08.000Z",
  counts: { turns: 4, actions: 3, blocked: 0, invalid: 0 },
});

const replay = (runId: string) => ({
  schema: "intyy.run/1.0",
  run_id: runId,
  kind: "replay",
  tenant: TENANT,
  capability: "kvfcu/open_share_subaccount",
  parent_run_id: null,
  batch_id: null,
  case_id: null,
  request_id: null,
  status: "failed",
  result: {
    schema: "intyy.result/1.0",
    run_id: runId,
    request_id: null,
    capability: { name: "kvfcu/open_share_subaccount", version: "1.0.0", patch_revision: null },
    status: "running",
    warnings: [],
    recoveries: [],
    interventions: [],
    timing: { started_at: "2026-10-01T10:15:02.004Z", ended_at: null, duration_ms: 1000, human_ms: 0 },
    evidence: `runs/${runId}/`,
  },
  frozen: { models: null },
  files: [],
  retention: { debug_until: "2026-10-31", audit_until: "2027-09-30" },
});

/** A store holding a replay run and three discovery runs, one per status. */
async function store(): Promise<FakeEvidenceStore> {
  const evidence = new FakeEvidenceStore();
  const runs: [string, unknown][] = [
    [REPLAY_RUN, replay(REPLAY_RUN)],
    ["run_2026-10-01_0000000003", discovery("run_2026-10-01_0000000003", "success")],
    ["run_2026-10-01_0000000004", discovery("run_2026-10-01_0000000004", "failed")],
    ["run_2026-10-01_0000000005", discovery("run_2026-10-01_0000000005", "business_outcome")],
  ];
  for (const [id, json] of runs) {
    const created = await evidence.createRun(TENANT, id);
    if (!created.ok) throw new Error("createRun failed");
    await created.value.writeRunJson(masked(json));
  }
  return evidence;
}

const detailOf = (got: Outcome<void, "invalid">): string => (got.ok ? "" : (got.detail ?? ""));
const waiver = (extra: Record<string, unknown>): string => JSON.stringify({ reason: "No screen shows the result.", ...extra });
const HEAD = "a waiver needs attempt_run: the discovery run that found no screen to read the result";

describe("checkWaiverAttempt", () => {
  test("a value that is not JSON is invalid", async () => {
    const got = await checkWaiverAttempt({ evidence: await store() }, TENANT, "not json");
    expect(got).toMatchObject({ ok: false, failure: "invalid" });
    expect(detailOf(got)).toContain(HEAD);
  });

  test("no attempt_run is invalid and names attempt_run", async () => {
    const got = await checkWaiverAttempt({ evidence: await store() }, TENANT, waiver({}));
    expect(got).toMatchObject({ ok: false, failure: "invalid" });
    expect(detailOf(got)).toContain("attempt_run");
  });

  test("a malformed attempt_run is invalid and names attempt_run", async () => {
    const got = await checkWaiverAttempt({ evidence: await store() }, TENANT, waiver({ attempt_run: "run_x" }));
    expect(got).toMatchObject({ ok: false, failure: "invalid" });
    expect(detailOf(got)).toContain("attempt_run");
  });

  test("a run that is not in the tenant's store is invalid", async () => {
    const got = await checkWaiverAttempt({ evidence: await store() }, TENANT, waiver({ attempt_run: UNKNOWN_RUN }));
    expect(got).toMatchObject({ ok: false, failure: "invalid" });
    expect(detailOf(got)).toContain(HEAD);
    expect(detailOf(got)).toContain(UNKNOWN_RUN);
  });

  test("a run that exists only under another tenant is invalid", async () => {
    const got = await checkWaiverAttempt({ evidence: await store() }, "othertenant", waiver({ attempt_run: "run_2026-10-01_0000000004" }));
    expect(got).toMatchObject({ ok: false, failure: "invalid" });
  });

  test("a replay run is invalid", async () => {
    const got = await checkWaiverAttempt({ evidence: await store() }, TENANT, waiver({ attempt_run: REPLAY_RUN }));
    expect(got).toMatchObject({ ok: false, failure: "invalid" });
    expect(detailOf(got)).toContain("replay");
  });

  test("a discovery run that ended success is invalid: it found a screen", async () => {
    const got = await checkWaiverAttempt({ evidence: await store() }, TENANT, waiver({ attempt_run: "run_2026-10-01_0000000003" }));
    expect(got).toMatchObject({ ok: false, failure: "invalid" });
    expect(detailOf(got)).toContain("success");
  });

  test.each(["run_2026-10-01_0000000004", "run_2026-10-01_0000000005"])("a discovery run that did not succeed (%s) is ok", async (runId) => {
    const got = await checkWaiverAttempt({ evidence: await store() }, TENANT, waiver({ attempt_run: runId }));
    expect(got).toEqual({ ok: true, value: undefined });
  });
});
