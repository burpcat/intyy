// Proves the two real library drafts of M06 task 7: copied into a temp root, `testdata check`
// and `faults check` both pass, and the testdata draft holds no value from the real, checked-in
// `intyy.json`'s `canary_members` (read at run time, never hardcoded; CLAUDE.md). Design section
// 8 §6.2, §6.3 and section 9 §8.7. M06 task 7.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { Config } from "../../../src/core/model/config.js";
import { Testdata } from "../../../src/core/model/testdata.js";
import { call, cleanRoots, tempRoot } from "./helpers.js";

afterAll(cleanRoots);

const REPO_ROOT = join(import.meta.dirname, "../../..");

const cli = (r: string, staff: string, argv: string[]) =>
  call(argv, { cwd: r, env: { INTYY_STAFF: staff }, deps: { commands } });

/** Copies a real draft into a temp root's library, at the same relative path. */
function copyDraft(r: string, relPath: string): void {
  const src = join(REPO_ROOT, "library", relPath);
  const dest = join(r, "library", relPath);
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, readFileSync(src));
}

describe("the real testdata draft", () => {
  test("check passes in a temp root", async () => {
    const r = tempRoot();
    copyDraft(r, "testdata/keystone/kvfcu/1.candidate.json");
    const checked = await cli(r, "op_017", ["testdata", "check", "kvfcu"]);
    expect(checked.code).toBe(EXIT.ok);
  });

  test("holds no value from the real intyy.json's canary_members", () => {
    const config = Config.parse(
      JSON.parse(readFileSync(join(REPO_ROOT, "intyy.json"), "utf8")),
    );
    const doc = Testdata.parse(
      JSON.parse(
        readFileSync(
          join(REPO_ROOT, "library", "testdata", "keystone", "kvfcu", "1.candidate.json"),
          "utf8",
        ),
      ),
    );
    const canary = new Set(config.canary_members);
    const hits = Object.values(doc.pools)
      .flat()
      .filter((v) => canary.has(v));
    expect(hits).toEqual([]);
  });
});

describe("the real faults draft", () => {
  test("check passes in a temp root", async () => {
    const r = tempRoot();
    copyDraft(r, "faults/kvfcu/1.candidate.json");
    const checked = await cli(r, "op_017", ["faults", "check", "kvfcu"]);
    expect(checked.code).toBe(EXIT.ok);
  });
});
