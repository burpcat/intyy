// Proves the `intyy evidence publish | verify` command shell (design section 9 §6.6, §7 role
// table, §7.5 exit codes): publish needs the reviewer role (exit 6), a trust key is skipped with a
// note until M10, a bad `--with-runs` or target is a usage error (exit 1), and verify needs the
// tenant's approved settings (exit 7) because the secret canary reads their bindings. The checks
// themselves are proven in tests/unit/evidence/publish.test.ts. M07 task 10.
import { afterAll, describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { call, cleanRoots, tempRoot } from "./helpers.js";

afterAll(cleanRoots);

const RUN = "run_2026-01-15_aaaaaaaaaa";

const cli = (cwd: string, staff: string, argv: string[]) =>
  call(argv, { cwd, env: { INTYY_STAFF: staff }, deps: { commands } });

describe("evidence publish", () => {
  test("without the reviewer role it exits 6 and publishes nothing", async () => {
    const root = tempRoot();
    // op_031 is an approver only.
    const r = await cli(root, "op_031", ["evidence", "publish", RUN]);
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toContain("reviewer");
  });

  test("a trust key prints a skip note and publishes nothing", async () => {
    const root = tempRoot();
    const r = await cli(root, "op_017", ["evidence", "publish", "kvfcu/open_sub@1.0.0"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stderr).toContain("skipped");
  });

  test("--with-runs takes only `all`", async () => {
    const root = tempRoot();
    const r = await cli(root, "op_017", ["evidence", "publish", RUN, "--with-runs", "x"]);
    expect(r.code).toBe(EXIT.usage);
  });

  test("a target that is no run ID, batch ID, or key is a usage error", async () => {
    const root = tempRoot();
    const r = await cli(root, "op_017", ["evidence", "publish", "not-a-target"]);
    expect(r.code).toBe(EXIT.usage);
  });

  test("a run with no approved settings stops before copying anything", async () => {
    const root = tempRoot();
    const r = await cli(root, "op_017", ["evidence", "publish", RUN]);
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toContain("settings");
  });
});

describe("evidence verify", () => {
  test("with no approved settings it exits 7: the secret canary could not run", async () => {
    const root = tempRoot();
    const r = await cli(root, "op_017", ["evidence", "verify"]);
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toContain("settings");
  });
});
