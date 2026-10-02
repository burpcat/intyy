// Proves the check-first reconciliation shape (owner decisions, 2026-10-01; section 2 §16): a
// check with no mode is `reference`; a `count_diff` check needs `count_output` and maps no
// outputs and no not_found_outcomes; a waiver must cite `attempt_run`. Loader issue
// `reconciliation_count_shape` sits at its own path. Synthetic values only.
import { describe, expect, test } from "vitest";
import { checkArtifact } from "../../../src/core/model/artifact-checks.js";
import { Artifact } from "../../../src/core/model/artifact.js";
import { artifactExample } from "../../fixtures/design-examples.js";

const ATTEMPT = "run_2026-10-01_0123456789";
const CHECK = "recovery.reconciliation.check";

/**
 * The §21 example with its reconciliation check replaced. With `countDiff`, the base is a valid
 * count_diff check and `patch` is merged over it; without, `patch` is merged over the example's
 * own reference check.
 */
function withCheck(patch: Record<string, unknown>, countDiff = true): Record<string, unknown> {
  const doc = structuredClone(artifactExample());
  const recon = (doc.recovery as Record<string, Record<string, unknown>>).reconciliation;
  if (recon === undefined) throw new Error("fixture has no reconciliation");
  const old = recon.check as Record<string, unknown>;
  recon.check = countDiff
    ? {
        capability: old.capability,
        mode: "count_diff",
        inputs: old.inputs,
        not_found_outcomes: [],
        outputs: {},
        count_output: "sub_account_count",
        ...patch,
      }
    : { ...old, ...patch };
  return doc;
}

/** Issues the loader reports for `doc`, as `code@path`. */
function issues(doc: Record<string, unknown>): string[] {
  return checkArtifact(Artifact.parse(doc), "strict").map((p) => `${p.code}@${p.path}`);
}

describe("reconciliation check mode", () => {
  test("a reconciliation check validates its mode fields", () => {
    // a check with no mode parses as reference
    {
      const parsed = Artifact.parse(structuredClone(artifactExample()));
      expect(parsed.recovery?.reconciliation).toMatchObject({ check: { mode: "reference" } });
    }
    // a valid count_diff check gives no issue
    expect(issues(withCheck({}))).toEqual([]);
    // count_diff without count_output is reported at count_output
    expect(issues(withCheck({ count_output: undefined }))).toEqual([`reconciliation_count_shape@${CHECK}.count_output`]);
    // count_diff with outputs is reported at outputs
    expect(issues(withCheck({ outputs: { account_number: "{result.account_number}" } }))).toEqual([
      `reconciliation_count_shape@${CHECK}.outputs`,
    ]);
    // count_diff with not_found_outcomes is reported at not_found_outcomes
    expect(issues(withCheck({ not_found_outcomes: ["not_found"] }))).toEqual([
      `reconciliation_count_shape@${CHECK}.not_found_outcomes`,
    ]);
    // a reference check naming count_output is reported at count_output
    expect(issues(withCheck({ count_output: "sub_account_count" }, false))).toEqual([
      `reconciliation_count_shape@${CHECK}.count_output`,
    ]);
    // an unknown mode fails the parse
    expect(Artifact.safeParse(withCheck({ mode: "bogus" })).success).toBe(false);
  });
});

describe("reconciliation waiver", () => {
  /** The example with a waiver in place of the check. */
  function withWaiver(waiver: Record<string, unknown>): Record<string, unknown> {
    const doc = structuredClone(artifactExample());
    (doc.recovery as Record<string, unknown>).reconciliation = { waiver };
    return doc;
  }

  test("a reconciliation waiver needs a well-formed attempt_run", () => {
    // a waiver citing a well-formed attempt_run parses
    expect(Artifact.safeParse(withWaiver({ reason: "No screen shows the result.", attempt_run: ATTEMPT })).success).toBe(true);
    // a waiver without attempt_run fails the parse
    expect(Artifact.safeParse(withWaiver({ reason: "No screen shows the result." })).success).toBe(false);
    // a waiver with a malformed attempt_run fails the parse
    expect(Artifact.safeParse(withWaiver({ reason: "No screen.", attempt_run: "run_oops" })).success).toBe(false);
  });
});
