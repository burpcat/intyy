// Proves the recorder loads a run's spec by the name `run.json` records in `spec` (so a negative
// run finds its own `expected_outcome` spec), and falls back to the plain capability when a run
// has no `spec`. Also proves the `RunJson` schema's `spec` field. In-memory fakes only.
// Design section 6 §14.8 (negative runs attach); docs/decisions.md, M05.
import { describe, expect, test } from "vitest";
import { CandidateDecision } from "../../../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../../../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../../../src/core/model/candidate-runs.js";
import { Artifact } from "../../../src/core/model/artifact.js";
import { RunJson } from "../../../src/core/model/run.js";
import type { Settings } from "../../../src/core/model/settings.js";
import { settingsKind } from "../../../src/core/model/kinds.js";
import { recordPositiveRun, type CandidateDeps } from "../../../src/core/recorder/candidates.js";
import { fail } from "../../../src/ports/outcome.js";
import type { Masked } from "../../../src/ports/masked.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { SeededIds } from "../../../src/fakes/ids.js";
import { FakeCandidateStore, FakeDocumentStore, FakeEvidenceStore } from "../../../src/fakes/stores.js";

/** Test data holds no secret, so it counts as masked. */
const masked = <T,>(v: T): Masked<T> => v as Masked<T>;

const TENANT = "keystone";
const RUN_ID = "run_2026-09-24_0000000001";

const runJson = (extra: Record<string, unknown>) => ({
  schema: "intyy.run/1.0",
  run_id: RUN_ID,
  tenant: TENANT,
  kind: "discovery",
  capability: "kvfcu/x",
  status: "success",
  code: null,
  started_at: "2026-09-24T10:00:00.000Z",
  ended_at: "2026-09-24T10:00:08.000Z",
  counts: { turns: 1, actions: 0, blocked: 0, invalid: 0 },
  ...extra,
});

/** Deps over a store holding only this `run.json`; `specs` records each lookup and finds nothing. */
async function setup(extra: Record<string, unknown>) {
  const clock = new SteppingClock("2026-09-28T14:00:00.000Z");
  const evidence = new FakeEvidenceStore();
  const created = await evidence.createRun(TENANT, RUN_ID);
  if (!created.ok) throw new Error("createRun failed");
  await created.value.writeRunJson(masked(runJson(extra)));
  const asked: [string, string][] = [];
  const deps: CandidateDeps = {
    candidates: new FakeCandidateStore(
      {
        files: { "runs.json": CandidateRuns, "candidate.json": Artifact, "issues.json": CandidateIssues },
        decision: CandidateDecision,
      },
      clock,
    ),
    evidence,
    settings: new FakeDocumentStore<Settings>(settingsKind, clock),
    ids: new SeededIds(clock),
    clock,
    specs: (app, name) => {
      asked.push([app, name]);
      return Promise.resolve(fail("not_found", `${app}/${name}`));
    },
  };
  return { deps, asked };
}

describe("which spec the recorder loads for a run", () => {
  test("run.json's spec names it, variant suffix and all", async () => {
    const { deps, asked } = await setup({ spec: "kvfcu/x.missing" });
    await recordPositiveRun(deps, TENANT, RUN_ID);
    expect(asked).toEqual([["kvfcu", "x.missing"]]);
  });

  test("a run with no spec loads the plain capability spec", async () => {
    const { deps, asked } = await setup({});
    await recordPositiveRun(deps, TENANT, RUN_ID);
    expect(asked).toEqual([["kvfcu", "x"]]);
  });
});

describe("RunJson's spec field", () => {
  test("is optional and accepts a well-formed name", () => {
    for (const spec of ["kvfcu/x", "kvfcu/open_share_subaccount.at_limit"]) {
      expect(RunJson.safeParse(runJson({ spec })).success, spec).toBe(true);
    }
    expect(RunJson.safeParse(runJson({})).success).toBe(true);
  });

  test("rejects a malformed name", () => {
    for (const spec of ["x", "kvfcu/", "kvfcu/x.", "KVFCU/x", "kvfcu/x.a.b", "kvfcu/x y", ""]) {
      expect(RunJson.safeParse(runJson({ spec })).success, JSON.stringify(spec)).toBe(false);
    }
  });
});
