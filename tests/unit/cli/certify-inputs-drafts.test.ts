// Proves the two real library files of M06 task 7, now sealed and approved: the testdata and
// faults revisions parse with their schemas, and the testdata holds no value from the real,
// checked-in `intyy.json`'s `canary_members` (read at run time, never hardcoded; CLAUDE.md).
// The drafts' `check` ran at seal time; a sealed revision has no candidate to check. Design
// section 8 §6.2, §6.3 and section 9 §8.7. M06 task 7.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Config } from "../../../src/core/model/config.js";
import { Faults } from "../../../src/core/model/faults.js";
import { Testdata } from "../../../src/core/model/testdata.js";

const REPO_ROOT = join(import.meta.dirname, "../../..");

/** One real library file, parsed as JSON. */
const libraryFile = (relPath: string): unknown =>
  JSON.parse(readFileSync(join(REPO_ROOT, "library", relPath), "utf8"));

describe("the real testdata revision", () => {
  test("parses with its schema", () => {
    expect(Testdata.safeParse(libraryFile("testdata/keystone/kvfcu/1.json")).success).toBe(true);
  });

  test("holds no value from the real intyy.json's canary_members", () => {
    const config = Config.parse(JSON.parse(readFileSync(join(REPO_ROOT, "intyy.json"), "utf8")));
    const doc = Testdata.parse(libraryFile("testdata/keystone/kvfcu/1.json"));
    const canary = new Set(config.canary_members);
    const hits = Object.values(doc.pools)
      .flat()
      .filter((v) => canary.has(v));
    expect(hits).toEqual([]);
  });
});

describe("the real faults revision", () => {
  test("parses with its schema", () => {
    expect(Faults.safeParse(libraryFile("faults/kvfcu/1.json")).success).toBe(true);
  });
});
