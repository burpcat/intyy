// Proves `checkAttachTarget`'s Outcome shapes against the fake candidate store: ok for a real
// candidate of the spec's capability; every refusal is `not_found` with a detail naming what to
// write. Design section 6 §14.8. Synthetic values only.
import { describe, expect, test } from "vitest";
import { checkAttachTarget } from "../../../src/core/recorder/candidates.js";
import { Artifact } from "../../../src/core/model/artifact.js";
import { CandidateDecision } from "../../../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../../../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../../../src/core/model/candidate-runs.js";
import { ManualClock } from "../../../src/fakes/clock.js";
import { FakeCandidateStore } from "../../../src/fakes/stores.js";
import type { Outcome } from "../../../src/ports/outcome.js";

const CAP = "kvfcu/sign_in";
const SUFFIX = "cand_2026-10-01_7kq2m9x4tb";
const ID = `${CAP}/${SUFFIX}`;
const OTHER = `kvfcu/other_cap/${SUFFIX}`;

async function deps() {
  const candidates = new FakeCandidateStore(
    {
      files: { "runs.json": CandidateRuns, "candidate.json": Artifact, "issues.json": CandidateIssues },
      decision: CandidateDecision,
    },
    new ManualClock(),
  );
  const runs = CandidateRuns.parse({
    schema: "intyy.candidate_runs/1.0",
    positive: { run_id: "run_2026-10-01_aaaaaaaaaa", tenant: "keystone" },
    negatives: [],
  });
  await candidates.putFile(ID, "runs.json", runs);
  await candidates.putFile(OTHER, "runs.json", runs);
  return { candidates };
}

/** The refusal's detail, or "" for a success. */
const detailOf = (got: Outcome<void, "not_found">): string => (got.ok ? "" : (got.detail ?? ""));

describe("checkAttachTarget", () => {
  test("checkAttachTarget accepts a full id and names what to write for every refusal", async () => {
    {
      // a full id of the spec's capability is ok
      expect(await checkAttachTarget(await deps(), CAP, ID)).toEqual({ ok: true, value: undefined });
    }
    {
      // a bare suffix that exists names the full id
      const got = await checkAttachTarget(await deps(), CAP, SUFFIX);
      expect(got).toMatchObject({ ok: false, failure: "not_found" });
      expect(detailOf(got)).toContain("full <app>/<capability>");
      expect(detailOf(got)).toContain(`Did you mean ${ID}?`);
    }
    {
      // a bare suffix that exists only under another capability gets no did-you-mean
      const got = await checkAttachTarget(await deps(), "kvfcu/third_cap", SUFFIX);
      expect(got).toMatchObject({ ok: false, failure: "not_found" });
      expect(detailOf(got)).toContain("full <app>/<capability>");
      expect(detailOf(got)).not.toContain("Did you mean");
    }
    {
      // a full id that does not exist says so
      const got = await checkAttachTarget(await deps(), CAP, `${CAP}/cand_2026-10-01_0000000000`);
      expect(got).toMatchObject({ ok: false, failure: "not_found" });
      expect(detailOf(got)).toContain("no such candidate");
    }
    {
      // a full id under another capability names the spec's capability
      const got = await checkAttachTarget(await deps(), CAP, OTHER);
      expect(got).toMatchObject({ ok: false, failure: "not_found" });
      expect(detailOf(got)).toContain("not that capability");
      expect(detailOf(got)).toContain(CAP);
    }
  });
});
