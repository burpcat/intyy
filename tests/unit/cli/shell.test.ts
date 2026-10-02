// Proves the CLI shell: root lookup, global flags, output rules, exit codes, the .env loader,
// role checks, and the sweep that runs first. Design section 9 §7.3 to §7.8; M01 test gate.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { FileLockSlots } from "../../../src/adapters/files/locks.js";
import { requireRole, takeLock } from "../../../src/cli/context.js";
import { loadDotEnv } from "../../../src/cli/env.js";
import { EXIT, exitForFailure, exitForStatus } from "../../../src/cli/exit-codes.js";
import { act, type Register } from "../../../src/cli/program.js";
import { call, cleanRoots, tempRoot } from "./helpers.js";

afterAll(cleanRoots);

const ORIGIN_KEY = "http_127.0.0.1_8080";

/** A test command: prints its context, with one sensitive value. */
function probe(log: string[] = []): Register {
  return (program, ctxOf) => {
    program.command("probe").action(
      act(ctxOf, (ctx) => {
        log.push("action");
        const data = (raw: boolean) => ({
          tenant: ctx.tenant,
          staff: ctx.staff,
          balance: raw ? "137.00" : "[money]",
        });
        return Promise.resolve({
          text: (raw) =>
            `tenant ${ctx.tenant}, staff ${ctx.staff ?? "none"}, balance ${data(raw).balance}`,
          data,
        });
      }),
    );
    program.command("refuse").action(
      act(ctxOf, (ctx) => {
        requireRole(ctx, ctx.tenant, "approver");
        return Promise.resolve({ text: () => "approved", data: () => ({}) });
      }),
    );
    program.command("crash").action(
      act(ctxOf, () => {
        throw new Error("boom");
      }),
    );
  };
}

describe("data root and identity", () => {
  test("root lookup: walks up to intyy.json; --root overrides; a missing or invalid intyy.json is refused", async () => {
    // finds intyy.json by walking up; the tenant defaults to default_tenant
    const root = tempRoot();
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    const found = await call(["probe", "--json"], { cwd: deep, deps: { commands: [probe()] } });
    expect(found.code).toBe(0);
    expect(JSON.parse(found.stdout)).toMatchObject({ tenant: "keystone", staff: null });

    // --root overrides the lookup; a root with no intyy.json is a usage error
    const ok = await call(["--root", root, "probe"], { cwd: "/", deps: { commands: [probe()] } });
    expect(ok.code).toBe(0);
    const bad = await call(["--root", "/", "probe"], { cwd: root, deps: { commands: [probe()] } });
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.stderr).toContain("holds no intyy.json");

    // no intyy.json anywhere up is a usage error
    const none = await call(["probe"], { cwd: "/", deps: { commands: [probe()] } });
    expect(none.code).toBe(EXIT.usage);

    // an invalid intyy.json exits 7
    const invalidRoot = tempRoot();
    writeFileSync(join(invalidRoot, "intyy.json"), JSON.stringify({ schema: "intyy.config/1.0" }));
    const invalid = await call(["probe"], { cwd: invalidRoot, deps: { commands: [probe()] } });
    expect(invalid.code).toBe(EXIT.invalid);
  });

  test("--tenant overrides the default and a bad tenant ID is refused; staff comes from --staff, then INTYY_STAFF", async () => {
    const root = tempRoot();
    const r = await call(["--tenant", "lakeshore", "probe", "--json"], {
      cwd: root,
      deps: { commands: [probe()] },
    });
    expect(JSON.parse(r.stdout)).toMatchObject({ tenant: "lakeshore" });
    const bad = await call(["--tenant", "../x", "probe"], {
      cwd: root,
      deps: { commands: [probe()] },
    });
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.stderr).toContain("--tenant ../x");

    const deps = { commands: [probe()] };
    const env = await call(["probe", "--json"], {
      cwd: root,
      env: { INTYY_STAFF: "op_022" },
      deps,
    });
    expect(JSON.parse(env.stdout)).toMatchObject({ staff: "op_022" });
    const flag = await call(["--staff", "op_031", "probe", "--json"], {
      cwd: root,
      env: { INTYY_STAFF: "op_022" },
      deps,
    });
    expect(JSON.parse(flag.stdout)).toMatchObject({ staff: "op_031" });
  });
});

describe("the .env loader", () => {
  test("never overrides a variable already set; a missing .env changes nothing; the CLI loads .env before INTYY_STAFF", async () => {
    // never overrides a variable already set
    const root = tempRoot();
    writeFileSync(
      join(root, ".env"),
      "INTYY_STAFF=op_017\nJEV_API_KEY=from-file\n# a comment\nEMPTY=\n",
    );
    const env: Record<string, string | undefined> = { INTYY_STAFF: "op_031" };
    expect(loadDotEnv(root, env).sort()).toEqual(["EMPTY", "JEV_API_KEY"]);
    expect(env.INTYY_STAFF).toBe("op_031");
    expect(env.JEV_API_KEY).toBe("from-file");

    // a missing .env changes nothing
    const empty: Record<string, string | undefined> = {};
    expect(loadDotEnv(tempRoot(), empty)).toEqual([]);
    expect(empty).toEqual({});

    // the CLI loads .env before it reads INTYY_STAFF
    const cliRoot = tempRoot();
    writeFileSync(join(cliRoot, ".env"), "INTYY_STAFF=op_017\n");
    const deps = { commands: [probe()] };
    const fromFile = await call(["probe", "--json"], { cwd: cliRoot, deps });
    expect(JSON.parse(fromFile.stdout)).toMatchObject({ staff: "op_017" });
    const shellWins = await call(["probe", "--json"], {
      cwd: cliRoot,
      env: { INTYY_STAFF: "op_022" },
      deps,
    });
    expect(JSON.parse(shellWins.stdout)).toMatchObject({ staff: "op_022" });
  });
});

describe("output rules", () => {
  test("a terminal gets raw outputs and a pipe gets them masked; --json prints one document; errors go to standard error", async () => {
    const root = tempRoot();
    const deps = { commands: [probe()] };
    const tty = await call(["probe"], { cwd: root, tty: true, deps });
    expect(tty.stdout).toBe("tenant keystone, staff none, balance 137.00\n");
    const pipe = await call(["probe"], { cwd: root, tty: false, deps });
    expect(pipe.stdout).toBe("tenant keystone, staff none, balance [money]\n");

    // --json prints exactly one JSON document, and nothing else on standard output
    const json = await call(["probe", "--json"], { cwd: root, deps });
    expect(() => JSON.parse(json.stdout) as unknown).not.toThrow();
    expect(JSON.parse(json.stdout)).toEqual({ tenant: "keystone", staff: null, balance: "[money]" });

    // errors go to standard error; --json still prints one document
    const r = await call(["refuse", "--json"], {
      cwd: root,
      env: { INTYY_STAFF: "op_017" },
      deps,
    });
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toContain("role: op_017 lacks the approver role for tenant keystone");
    expect(JSON.parse(r.stdout)).toEqual({
      error: { code: 6, message: expect.stringContaining("role") as string },
    });
  });

  test("flags and commands are checked: --reveal-outputs and --models, certify case, unknown input, a bug, -V", async () => {
    const root = tempRoot();
    const deps = { commands: [probe()] };
    // --reveal-outputs and --models are refused on commands that do not take them
    const reveal = await call(["--reveal-outputs", "probe"], { cwd: root, deps });
    expect(reveal.code).toBe(EXIT.usage);
    expect(reveal.stderr).toContain("--reveal-outputs works only on replay and reconcile");
    const models = await call(["--models", "off", "probe"], { cwd: root, deps });
    expect(models.code).toBe(EXIT.usage);
    expect(models.stderr).toContain("--models works only on replay, certify, and reconcile");

    // --models off is taken by a subcommand of certify, like certify case
    const certifyCase: Register = (program, ctxOf) => {
      program
        .command("certify")
        .command("case")
        .action(act(ctxOf, () => Promise.resolve({ text: () => "ran", data: () => ({}) })));
    };
    const caseRun = await call(["--models", "off", "certify", "case"], { cwd: root, deps: { commands: [certifyCase] } });
    expect(caseRun.code).toBe(EXIT.ok);
    expect(caseRun.stdout).toContain("ran");

    // an unknown command or option is a usage error
    expect((await call(["nope"], { cwd: root, deps })).code).toBe(EXIT.usage);
    expect((await call(["probe", "--nope"], { cwd: root, deps })).code).toBe(EXIT.usage);

    // a bug exits 1 as an internal error
    const crash = await call(["crash"], { cwd: tempRoot(), deps });
    expect(crash.code).toBe(EXIT.usage);
    expect(crash.stderr).toContain("internal error: boom");

    // Why `-V`, not `--version`: `candidate seal` needs that long flag for its own semver
    // value (docs/decisions.md, M04); design section 9 §7.3 lists no `--version` global flag.
    const version = await call(["-V"], { cwd: tempRoot() });
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});

describe("role checks", () => {
  test("no staff ID is a usage error; an unknown or unqualified staff ID is refused", async () => {
    const root = tempRoot();
    const deps = { commands: [probe()] };
    const none = await call(["refuse"], { cwd: root, deps });
    expect(none.code).toBe(EXIT.usage);
    expect(none.stderr).toContain("pass --staff or set INTYY_STAFF");
    const unknown = await call(["refuse"], { cwd: root, env: { INTYY_STAFF: "op_999" }, deps });
    expect(unknown.code).toBe(EXIT.refused);
    expect(unknown.stderr).toContain("op_999 is not in staff.json");
    const ok = await call(["refuse"], { cwd: root, env: { INTYY_STAFF: "op_022" }, deps });
    expect(ok.code).toBe(0);
  });
});

describe("the sweep", () => {
  test("every command runs the sweep before its own work, and prints one line only when it closed a run", async () => {
    const log: string[] = [];
    const sweep = (tenant: string) => {
      log.push(`sweep ${tenant}`);
      return Promise.resolve({ closed: 0, manual: 0 });
    };
    await call(["probe"], { cwd: tempRoot(), deps: { commands: [probe(log)], sweep } });
    expect(log).toEqual(["sweep keystone", "action"]);

    const quiet = await call(["probe"], { cwd: tempRoot(), deps: { commands: [probe()] } });
    expect(quiet.stderr).toBe("");
    const loudSweep = () => Promise.resolve({ closed: 1, manual: 1 });
    const loud = await call(["probe"], { cwd: tempRoot(), deps: { commands: [probe()], sweep: loudSweep } });
    expect(loud.stderr).toBe(
      "Closed 1 crashed run. 1 needs a manual reconcile. See `intyy run sweep`.\n",
    );
  });
});

describe("exit codes (section 9 §7.5)", () => {
  test("each run status and each refusal or file failure maps to its code, and codes never overlap", () => {
    expect(exitForStatus("success")).toBe(0);
    expect(exitForStatus("business_outcome")).toBe(2);
    expect(exitForStatus("running")).toBe(3);
    expect(exitForStatus("escalated")).toBe(3);
    expect(exitForStatus("rejected")).toBe(4);
    expect(exitForStatus("failed")).toBe(5);

    expect(exitForFailure("rule")).toBe(6);
    expect(exitForFailure("conflict")).toBe(6);
    expect(exitForFailure("invalid")).toBe(7);
    expect(exitForFailure("hash_mismatch")).toBe(7);
    expect(exitForFailure("loosening")).toBe(7);
    expect(exitForFailure("busy")).toBe(8);
    expect(exitForFailure("not_found")).toBe(1);

    const codes = Object.values(EXIT);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("a busy lock exits 8 through the CLI and names the holder", async () => {
    const root = tempRoot();
    // Why another host: its lock is always held, whatever its process ID (section 9 §12.3).
    await new FileLockSlots(join(root, "state", "var", "locks")).create("instance", ORIGIN_KEY, {
      schema: "intyy.lock/1.0",
      owner: "batch_2026-01-15_aaaaaaaaaa",
      pid: 1,
      host: "other-host",
      command: "certify",
      staff: "op_017",
      started_at: "2026-01-15T08:00:00.000Z",
    });
    const lockProbe: Register = (program, ctxOf) => {
      program.command("lock").action(
        act(ctxOf, async (ctx) => {
          const req = {
            owner: "run_2026-01-15_7kq2m9x4tb",
            command: "replay",
            staff: null,
            waitMs: 0,
          };
          await takeLock(ctx, "instance", ORIGIN_KEY, req);
          return { text: () => "locked", data: () => ({}) };
        }),
      );
    };
    const r = await call(["lock"], { cwd: root, deps: { commands: [lockProbe] } });
    expect(r.code).toBe(EXIT.busy);
    expect(r.stderr).toContain("held by certify, staff op_017, since 2026-01-15T08:00:00.000Z");
  });
});
