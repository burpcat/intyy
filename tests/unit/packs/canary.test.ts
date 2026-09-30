// The canary scan reads the pack store and the fixture library too (design section 5 §13.6,
// section 4 §14 update), plus the testdata and faults stores added in M06 task 7 (M06 gate:
// "Canary scan: no canary value in the pack store or fixtures"). Reads the real, checked-in
// `library/packs/`, `library/fixtures/`, `library/testdata/`, and `library/faults/` folders
// read-only; never probes anything else (CLAUDE.md). `library/packs/` does not exist yet at M06
// task 1 (no pack is sealed until task 11); an empty folder scans clean, not an error. M06 tasks
// 1 and 7.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { Config } from "../../../src/core/model/config.js";
import { scanForCanaries, type ScanFile } from "../../../src/core/safety/canary/scan.js";
import { readTree } from "../safety/canary-kit.js";

const ROOT = join(import.meta.dirname, "../../..");

/** `intyy.json`'s own canary member list, read at run time, never hardcoded (CLAUDE.md). */
const config = Config.parse(JSON.parse(readFileSync(join(ROOT, "intyy.json"), "utf8")));

/** Every file under `dir`, or an empty list when the folder does not exist yet. */
async function filesUnder(dir: string): Promise<ScanFile[]> {
  return existsSync(dir) ? readTree(dir) : [];
}

describe("canary scan: the pack store and the fixture library (section 5 §13.6)", () => {
  test("no canary member appears anywhere in library/packs or library/fixtures", async () => {
    const files = [
      ...(await filesUnder(join(ROOT, "library", "packs"))),
      ...(await filesUnder(join(ROOT, "library", "fixtures"))),
    ];
    expect(scanForCanaries(files, config.canary_members)).toEqual([]);
  });
});

describe("canary scan: the testdata and faults stores (M06 gate)", () => {
  test("no canary member appears anywhere in library/testdata or library/faults", async () => {
    const files = [
      ...(await filesUnder(join(ROOT, "library", "testdata"))),
      ...(await filesUnder(join(ROOT, "library", "faults"))),
    ];
    expect(scanForCanaries(files, config.canary_members)).toEqual([]);
  });
});
