// Proves `intyy faults edit | check | seal | approve` (design section 9 §8.7; section 8 §6.3).
// Roles: faults is shared (scope `*`); op_017 reviews, op_031 approves (M06 library table). M06 task 7.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { call, cleanRoots, tempRoot } from "./helpers.js";

afterAll(cleanRoots);

const cli = (r: string, staff: string, argv: string[], extraEnv: Record<string, string> = {}) =>
  call(argv, { cwd: r, env: { INTYY_STAFF: staff, ...extraEnv }, deps: { commands } });

/** A minimal, clean fault profile set for `kvfcu`. */
function faultsBody(): Record<string, unknown> {
  return {
    schema: "intyy.faults/1.0",
    app: "kvfcu",
    revision: 1,
    profiles: [
      {
        id: "server_error",
        kind: "server_error",
        at: "@each_request_step",
        expect_commit: "reconciles_absent",
        expect_window: "recovers",
      },
    ],
  };
}

/** Runs `faults edit <app>` with `body` as the whole edited file (the `EDITOR: cp` trick). */
async function editWith(
  r: string,
  staff: string,
  app: string,
  body: Record<string, unknown>,
): ReturnType<typeof cli> {
  const editedPath = join(r, `edited-${String(Math.random()).slice(2)}.json`);
  writeFileSync(editedPath, JSON.stringify(body));
  return cli(r, staff, ["faults", "edit", app], { EDITOR: `cp "${editedPath}"` });
}

const APP = "kvfcu";

describe("faults edit, check", () => {
  test("edit refuses a duplicate profile ID and saves nothing; then edit saves a valid candidate and check passes", async () => {
    const r = tempRoot();
    const profiles = (faultsBody().profiles as Record<string, unknown>[])[0];
    const bad = { ...faultsBody(), profiles: [profiles, { ...profiles }] };
    const refused = await editWith(r, "op_017", APP, bad);
    expect(refused.code).toBe(EXIT.invalid);
    expect(refused.stderr).toContain("duplicate_profile");
    const none = await cli(r, "op_017", ["faults", "check", APP]);
    expect(none.code).toBe(EXIT.usage);

    const edited = await editWith(r, "op_017", APP, faultsBody());
    expect(edited.code).toBe(EXIT.ok);
    const checked = await cli(r, "op_017", ["faults", "check", APP]);
    expect(checked.code).toBe(EXIT.ok);
  });
});

describe("faults seal, approve: roles (scope * has no staff with both reviewer and approver)", () => {
  test("op_017 seals but has no approver role; op_022 lacks the * scope; op_031 approves", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", APP, faultsBody());
    const sealed = await cli(r, "op_017", ["faults", "seal", APP]);
    expect(sealed.code).toBe(EXIT.ok);
    // the sealer op_017 has no approver role at all; the role check refuses first
    const selfApprove = await cli(r, "op_017", ["faults", "approve", APP, "--rev", "1"]);
    expect(selfApprove.code).toBe(EXIT.refused);
    expect(selfApprove.stderr).toContain("lacks the approver role for every tenant (*)");
    // op_022 approves only at keystone and lakeshore; faults needs the * scope
    const wrongScope = await cli(r, "op_022", ["faults", "approve", APP, "--rev", "1"]);
    expect(wrongScope.code).toBe(EXIT.refused);
    expect(wrongScope.stderr).toContain("lacks the approver role for every tenant (*)");
    const approved = await cli(r, "op_031", ["faults", "approve", APP, "--rev", "1"]);
    expect(approved.code).toBe(EXIT.ok);
  });
});
