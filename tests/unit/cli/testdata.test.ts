// Proves `intyy testdata edit | check | seal | approve` (design section 9 §8.7; section 8 §6.2).
// Roles: testdata is per tenant; op_017 reviews (via `*`), op_022 approves at keystone (M06
// library table). Also proves `testdata check` refuses an app whose settings say environment:
// production (section 9 §8.7). M06 task 7.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { call, cleanRoots, tempRoot } from "./helpers.js";

afterAll(cleanRoots);

const cli = (r: string, staff: string, argv: string[], extraEnv: Record<string, string> = {}) =>
  call(argv, { cwd: r, env: { INTYY_STAFF: staff, ...extraEnv }, deps: { commands } });

/** A minimal, clean test data candidate for `keystone/kvfcu`. */
function testdataBody(): Record<string, unknown> {
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

/** A minimal, clean settings candidate for `keystone`, one app's `environment` given. */
function settingsBody(environment: "test" | "production"): Record<string, unknown> {
  return {
    schema: "intyy.settings/1.0",
    tenant: "keystone",
    revision: 1,
    apps: {
      kvfcu: {
        origin: "http://127.0.0.1:8080",
        app_version: "9.2",
        environment,
        locale: "en-US",
        time_zone: "America/New_York",
        extra_origins: [],
        secrets: {},
      },
    },
  };
}

/** Runs `<noun> edit [args]` with `body` as the whole edited file (the `EDITOR: cp` trick). */
async function editWith(
  r: string,
  staff: string,
  argv: string[],
  body: Record<string, unknown>,
): ReturnType<typeof cli> {
  const editedPath = join(r, `edited-${String(Math.random()).slice(2)}.json`);
  writeFileSync(editedPath, JSON.stringify(body));
  return cli(r, staff, argv, { EDITOR: `cp "${editedPath}"` });
}

const ID = "keystone/kvfcu";

describe("testdata refuses an app whose settings say environment: production", () => {
  test("edit itself refuses, since it validates before saving; environment: test is fine", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", ["settings", "edit"], settingsBody("production"));
    await cli(r, "op_017", ["settings", "seal"]);
    await cli(r, "op_022", ["settings", "approve", "--rev", "1"]);

    const edited = await editWith(r, "op_017", ["testdata", "edit", "kvfcu"], testdataBody());
    expect(edited.code).toBe(EXIT.invalid);
    expect(edited.stderr).toContain("production_app");

    const testRoot = tempRoot();
    await editWith(testRoot, "op_017", ["settings", "edit"], settingsBody("test"));
    await cli(testRoot, "op_017", ["settings", "seal"]);
    await cli(testRoot, "op_022", ["settings", "approve", "--rev", "1"]);

    const fine = await editWith(testRoot, "op_017", ["testdata", "edit", "kvfcu"], testdataBody());
    expect(fine.code).toBe(EXIT.ok);
  });
});

describe("testdata edit, check, seal, approve: roles per tenant, and four eyes", () => {
  test("edit saves a valid candidate and check passes; op_017 seals (reviewer via *) but has no approver role; op_022 approves (approver at keystone)", async () => {
    const r = tempRoot();
    const edited = await editWith(r, "op_017", ["testdata", "edit", "kvfcu"], testdataBody());
    expect(edited.code).toBe(EXIT.ok);
    const checked = await cli(r, "op_017", ["testdata", "check", "kvfcu"]);
    expect(checked.code).toBe(EXIT.ok);

    const sealed = await cli(r, "op_017", ["testdata", "seal", "kvfcu"]);
    expect(sealed.code).toBe(EXIT.ok);
    // op_017 has no approver role at keystone or anywhere
    const wrongRole = await cli(r, "op_017", ["testdata", "approve", "kvfcu", "--rev", "1"]);
    expect(wrongRole.code).toBe(EXIT.refused);
    expect(wrongRole.stderr).toContain("lacks the approver role for tenant keystone");
    const approved = await cli(r, "op_022", ["testdata", "approve", "kvfcu", "--rev", "1"]);
    expect(approved.code).toBe(EXIT.ok);
  });

  test("four eyes: op_022 seals (reviewer via *) and may not also approve", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", ["testdata", "edit", "kvfcu"], testdataBody());
    expect((await cli(r, "op_022", ["testdata", "seal", "kvfcu"])).code).toBe(EXIT.ok);
    const selfApprove = await cli(r, "op_022", ["testdata", "approve", "kvfcu", "--rev", "1"]);
    expect(selfApprove.code).toBe(EXIT.refused);
    expect(selfApprove.stderr).toContain(`four eyes: op_022 sealed testdata ${ID} 1`);
  });
});
