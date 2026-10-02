// Proves the `intyy evidence publish | verify` command shell (design section 9 §6.6, §7 role
// table, §7.5 exit codes): publish needs the reviewer role (exit 6); a trust key needs the
// tenant's settings (exit 7), publishes its snapshot and the batches its history names when it has
// score files, and is not_found (exit 1) when it has none; a bad `--with-runs` or target is a
// usage error (exit 1); and verify needs the tenant's approved settings (exit 7) because the
// secret canary reads their bindings. The checks themselves are proven in
// tests/unit/evidence/publish.test.ts and publish-key.test.ts. M07 task 10, M10 task 6.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { certifyCall, CAP, sealQuickInputs } from "./certify-kit.js";
import { call, cleanRoots, tempRoot } from "./helpers.js";
import { replayRoot } from "./replay-harness.js";

afterAll(cleanRoots);

const RUN = "run_2026-01-15_aaaaaaaaaa";
const LONG = { timeout: 120_000 };

const cli = (cwd: string, staff: string, argv: string[]) =>
  call(argv, { cwd, env: { INTYY_STAFF: staff }, deps: { commands } });

describe("evidence publish", () => {
  test("refusals publish nothing: no reviewer role, no approved settings, bad --with-runs or target", async () => {
    const root = tempRoot();
    // without the reviewer role it exits 6 and publishes nothing; op_031 is an approver only
    const role = await cli(root, "op_031", ["evidence", "publish", RUN]);
    expect(role.code).toBe(EXIT.refused);
    expect(role.stderr).toContain("reviewer");

    // a trust key with no approved settings exits 7: its app version comes from them
    const key = await cli(root, "op_017", ["evidence", "publish", "kvfcu/open_sub@1.0.0"]);
    expect(key.code).toBe(EXIT.invalid);
    expect(key.stderr).toContain("settings");

    // --with-runs takes only `all`
    const withRuns = await cli(root, "op_017", ["evidence", "publish", RUN, "--with-runs", "x"]);
    expect(withRuns.code).toBe(EXIT.usage);

    // a target that is no run ID, batch ID, or key is a usage error
    const target = await cli(root, "op_017", ["evidence", "publish", "not-a-target"]);
    expect(target.code).toBe(EXIT.usage);

    // a run with no approved settings stops before copying anything
    const run = await cli(root, "op_017", ["evidence", "publish", RUN]);
    expect(run.code).toBe(EXIT.invalid);
    expect(run.stderr).toContain("settings");

    // evidence verify with no approved settings exits 7: the secret canary could not run
    const verify = await cli(root, "op_017", ["evidence", "verify"]);
    expect(verify.code).toBe(EXIT.invalid);
    expect(verify.stderr).toContain("settings");
  });

  test("a trust key with no score files is not_found (exit 1); with score files it publishes the snapshot and the batches its history names, and verify is clean", LONG, async () => {
    const env = await replayRoot();
    const none = await certifyCall(env, "op_017", ["evidence", "publish", "kvfcu/open_sub@1.0.0"]);
    expect(none.code).toBe(EXIT.usage);
    expect(none.stderr).toContain("not_found");
    expect(existsSync(join(env.root, "evidence", "manifest.json"))).toBe(false);

    await sealQuickInputs(env);
    const quick = await certifyCall(env, "op_017", ["certify", CAP, "--kind", "quick", "--json"]);
    const batchId = (JSON.parse(quick.stdout) as { batch_id: string }).batch_id;

    const r = await certifyCall(env, "op_017", ["evidence", "publish", "kvfcu/open_sub@1.0.0"]);
    expect(r.stderr).not.toContain("refused");
    expect(r.code).toBe(EXIT.ok);
    const snapshot = join(env.root, "evidence", "trust", "scores", "keystone", "kvfcu", "open_sub@1.0.0", "8.4", "base");
    expect(existsSync(join(snapshot, "history.jsonl"))).toBe(true);
    expect(existsSync(join(snapshot, "record.json"))).toBe(true);
    const batchDir = join(env.root, "evidence", "keystone", "batches", batchId);
    expect(existsSync(join(batchDir, "plan.json"))).toBe(true);
    expect(existsSync(join(batchDir, "report.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(env.root, "evidence", "manifest.json"), "utf8")) as { items: { kind: string; id: string }[] };
    expect(manifest.items.filter((i) => i.kind === "key").map((i) => i.id)).toEqual(["keystone/kvfcu/open_sub@1.0.0/8.4/base"]);

    const verify = await certifyCall(env, "op_017", ["evidence", "verify"]);
    expect(verify.stderr).toBe("");
    expect(verify.code).toBe(EXIT.ok);
  });
});
