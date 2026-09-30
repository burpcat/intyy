// Proves `intyy suite edit | check | seal | approve` (design section 9 §8.7; section 8 §6.1).
// Roles: suite is shared (scope `*`); op_017 reviews, op_031 approves (M06 library table). M06 task 7.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { call, cleanRoots, tempRoot } from "./helpers.js";

afterAll(cleanRoots);

const cli = (r: string, staff: string, argv: string[], extraEnv: Record<string, string> = {}) =>
  call(argv, { cwd: r, env: { INTYY_STAFF: staff, ...extraEnv }, deps: { commands } });

/** A minimal, clean suite body. */
function suiteBody(): Record<string, unknown> {
  return {
    schema: "intyy.suite/1.0",
    capability: "kvfcu/open_share_subaccount@1",
    revision: 1,
    reason: "Test suite.",
    classes: [{ id: "valid", inputs: { member_id: "@members.valid" }, expect: { status: "success" } }],
    matrix: { class: "valid", profiles: "standard" },
    stability: { class: "valid", levels: [0.05], seeds: 1, twins: false },
    drills: { count: 0 },
    extra: [],
    setup: [],
    provenance: { runs: [], decisions: [], sealed: null },
  };
}

/** Runs `suite edit <capability>` with `body` as the whole edited file (the `EDITOR: cp` trick). */
async function editWith(
  r: string,
  staff: string,
  capability: string,
  body: Record<string, unknown>,
): ReturnType<typeof cli> {
  const editedPath = join(r, `edited-${String(Math.random()).slice(2)}.json`);
  writeFileSync(editedPath, JSON.stringify(body));
  return cli(r, staff, ["suite", "edit", capability], { EDITOR: `cp "${editedPath}"` });
}

const CAP = "kvfcu/open_share_subaccount@1";

describe("suite edit, check", () => {
  test("edit saves a valid candidate; check passes", async () => {
    const r = tempRoot();
    const edited = await editWith(r, "op_017", CAP, suiteBody());
    expect(edited.code).toBe(EXIT.ok);
    const checked = await cli(r, "op_017", ["suite", "check", CAP]);
    expect(checked.code).toBe(EXIT.ok);
  });

  test("edit refuses an unknown class named by the matrix; nothing is saved", async () => {
    const r = tempRoot();
    const bad = { ...suiteBody(), matrix: { class: "no_such_class", profiles: "standard" } };
    const edited = await editWith(r, "op_017", CAP, bad);
    expect(edited.code).toBe(EXIT.invalid);
    expect(edited.stderr).toContain("unknown_class");
    const checked = await cli(r, "op_017", ["suite", "check", CAP]);
    expect(checked.code).toBe(EXIT.usage);
  });
});

describe("suite seal, approve: roles (scope * has no staff with both reviewer and approver)", () => {
  test("op_017 seals; op_031 approves", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", CAP, suiteBody());
    const sealed = await cli(r, "op_017", ["suite", "seal", CAP]);
    expect(sealed.code).toBe(EXIT.ok);
    const approved = await cli(r, "op_031", ["suite", "approve", CAP, "--rev", "1"]);
    expect(approved.code).toBe(EXIT.ok);
  });

  test("the sealer op_017 has no approver role at all; the role check refuses first", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", CAP, suiteBody());
    await cli(r, "op_017", ["suite", "seal", CAP]);
    const selfApprove = await cli(r, "op_017", ["suite", "approve", CAP, "--rev", "1"]);
    expect(selfApprove.code).toBe(EXIT.refused);
    expect(selfApprove.stderr).toContain("lacks the approver role for every tenant (*)");
  });

  test("op_022 approves only at keystone and lakeshore; a suite needs the * scope", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", CAP, suiteBody());
    await cli(r, "op_017", ["suite", "seal", CAP]);
    const wrongScope = await cli(r, "op_022", ["suite", "approve", CAP, "--rev", "1"]);
    expect(wrongScope.code).toBe(EXIT.refused);
    expect(wrongScope.stderr).toContain("lacks the approver role for every tenant (*)");
  });

  test("approving twice is refused the second time", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", CAP, suiteBody());
    await cli(r, "op_017", ["suite", "seal", CAP]);
    await cli(r, "op_031", ["suite", "approve", CAP, "--rev", "1"]);
    const again = await cli(r, "op_031", ["suite", "approve", CAP, "--rev", "1"]);
    expect(again.code).toBe(EXIT.refused);
    expect(again.stderr).toContain("already approved");
  });
});
