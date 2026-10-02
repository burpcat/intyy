// Proves the test data schema (`intyy.testdata/1.0`) and its loader checks: `checkNoCanary` and
// `checkNotProduction`. Design section 8 §6.2 and section 9 §8.7. M06 task 7.
import { describe, expect, test } from "vitest";
import { checkNoCanary, checkNotProduction, Testdata } from "../../../src/core/model/testdata.js";

/** A minimal, clean test data set: one pool, one instance setting, a fixed business date. */
function baseTestdata(): Record<string, unknown> {
  return {
    schema: "intyy.testdata/1.0",
    tenant: "keystone",
    app: "kvfcu",
    revision: 1,
    pools: { "members.valid": ["100107", "100114"] },
    instance: { variant: "keystone", strip_semantics: false, drop_labels: 0, label_seed: "0" },
    business_date: "2026-01-15",
  };
}

describe("Testdata schema", () => {
  test("the Testdata schema accepts a clean set and rejects bad literals and pools", () => {
    // accepts a clean test data set
    expect(Testdata.safeParse(baseTestdata()).success).toBe(true);
    // rejects the wrong schema literal
    {
      const doc = { ...baseTestdata(), schema: "intyy.testdata/2.0" };
      expect(Testdata.safeParse(doc).success).toBe(false);
    }
    // rejects a pool name that is not dotted lower-case words
    {
      const doc = baseTestdata();
      doc.pools = { "Members.Valid": ["100107"] };
      expect(Testdata.safeParse(doc).success).toBe(false);
    }
    // rejects a pool name with a trailing dot
    {
      const doc = baseTestdata();
      doc.pools = { "members.": ["100107"] };
      expect(Testdata.safeParse(doc).success).toBe(false);
    }
    // rejects an empty pool
    {
      const doc = baseTestdata();
      doc.pools = { "members.valid": [] };
      expect(Testdata.safeParse(doc).success).toBe(false);
    }
  });
});

describe("checkNoCanary", () => {
  // Why: a made-up canary for this unit test, never the real seed member 100240 (CLAUDE.md).
  const MADE_UP_CANARY = "999999";

  test("checkNoCanary reports a configured canary and nothing else", () => {
    // a pool holding the configured canary is reported
    {
      const doc = baseTestdata();
      doc.pools = { "members.valid": ["100107", MADE_UP_CANARY] };
      const problems = checkNoCanary(Testdata.parse(doc), [MADE_UP_CANARY]);
      expect(problems).toEqual([`canary_value: members.valid: ${MADE_UP_CANARY} is the canary`]);
    }
    // a clean pool has no problems
    expect(checkNoCanary(Testdata.parse(baseTestdata()), [MADE_UP_CANARY])).toEqual([]);
    // an empty canary list never reports anything
    {
      const doc = baseTestdata();
      doc.pools = { "members.valid": ["100107"] };
      expect(checkNoCanary(Testdata.parse(doc), [])).toEqual([]);
    }
  });
});

describe("checkNotProduction", () => {
  test("checkNotProduction refuses production only", () => {
    // environment: production is refused
    expect(checkNotProduction("production")).toEqual([
      "production_app: test data is refused for an app whose settings say environment: production",
    ]);
    // environment: test is fine
    expect(checkNotProduction("test")).toEqual([]);
    // no settings yet (undefined) is fine
    expect(checkNotProduction(undefined)).toEqual([]);
  });
});
