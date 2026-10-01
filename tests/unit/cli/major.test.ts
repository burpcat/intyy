// Proves `intyy major deprecate | seal | approve | show` (design section 9 §9.6, section 8 §11.9):
// deprecate needs an approver on `*`, a valid date and successor, and a reason on standard input,
// and writes the next revision as a candidate; seal and approve give it force with four eyes (the
// sealer cannot approve); show prints the newest record and each tenant's retire date, which is
// empty until the successor is approved there. Temporary data roots only. M11 task 4.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { approved, batch } from "../trust/kit.js";
import { STAFF, call, cleanRoots, tempRoot } from "./helpers.js";

afterAll(cleanRoots);

const ID = "kvfcu/open_share_subaccount@1";
const REASON = "Version 2 replaces it.\n";

/** One call as `staff`. `stdin` is what a pipe would carry. */
const cli = (r: string, staff: string, argv: string[], stdin = "") =>
  call(argv, { cwd: r, env: { INTYY_STAFF: staff }, stdin, deps: { commands } });

/** `major deprecate`, as the approver op_031 unless told otherwise. */
const deprecate = (r: string, extra: string[] = ["--successor", "2", "--retires-on", "2099-01-31"], stdin = REASON, staff = "op_031") =>
  cli(r, staff, ["major", "deprecate", ID, ...extra], stdin);

/** A root where op_040 is both reviewer and approver on `*`, so the sealer can try to approve. */
function rootWithDualStaff(): string {
  const r = tempRoot();
  const staff = { ...STAFF, staff: [...STAFF.staff, { id: "op_040", roles: { "*": ["reviewer", "approver"] } }] };
  writeFileSync(join(r, "library", "staff.json"), JSON.stringify(staff));
  return r;
}

type Shown = {
  major: string;
  rev?: string;
  state?: string;
  record: { successor: number; retires_on: string; by: string; reason: string } | null;
  tenants: { tenant: string; successor_approved_here: boolean; retires_on: string | null }[];
};
const show = async (r: string): Promise<Shown> => JSON.parse((await cli(r, "op_017", ["major", "show", ID, "--json"])).stdout) as Shown;

describe("major deprecate", () => {
  test("an approver writes a candidate, revision 1", async () => {
    const r = tempRoot();
    const done = await deprecate(r);
    expect(done.code).toBe(EXIT.ok);
    expect(done.stdout).toContain("candidate 1");
    const shown = await show(r);
    expect(shown).toMatchObject({ rev: "1", state: "candidate", record: { successor: 2, retires_on: "2099-01-31", by: "op_031" } });
  });

  test("a non-approver is refused, and nothing is written", async () => {
    const r = tempRoot();
    expect((await deprecate(r, undefined, REASON, "op_017")).code).toBe(EXIT.refused);
    expect((await show(r)).record).toBeNull();
  });

  test("an approver at only some tenants is refused: the record applies to every bank (scope *)", async () => {
    const r = tempRoot();
    expect((await deprecate(r, undefined, REASON, "op_022")).code).toBe(EXIT.refused);
  });

  test("an empty standard input is refused", async () => {
    const r = tempRoot();
    for (const stdin of ["", "  \n"]) expect((await deprecate(r, undefined, stdin)).code).toBe(EXIT.usage);
    expect((await show(r)).record).toBeNull();
  });

  test("bad dates and bad successors are refused, and nothing is written", async () => {
    const r = tempRoot();
    const bad = [
      ["--successor", "2", "--retires-on", "next spring"],
      ["--successor", "2", "--retires-on", "2099-13-45"],
      ["--successor", "2", "--retires-on", "2000-01-01"], // before today
      ["--successor", "1", "--retires-on", "2099-01-31"], // not later than the major
      ["--successor", "two", "--retires-on", "2099-01-31"],
    ];
    for (const extra of bad) expect((await deprecate(r, extra)).code, extra.join(" ")).not.toBe(EXIT.ok);
    expect((await show(r)).record).toBeNull();
  });

  test("a missing flag is a usage error", async () => {
    const r = tempRoot();
    expect((await deprecate(r, ["--successor", "2"])).code).toBe(EXIT.usage);
    expect((await deprecate(r, ["--retires-on", "2099-01-31"])).code).toBe(EXIT.usage);
  });

  test("a major that is not app/capability@n is a usage error", async () => {
    const r = tempRoot();
    const bad = await cli(r, "op_031", ["major", "deprecate", "open_share_subaccount", "--successor", "2", "--retires-on", "2099-01-31"], REASON);
    expect(bad.code).toBe(EXIT.usage);
  });

  test("after an approved revision, the next deprecate counts up", async () => {
    const r = rootWithDualStaff();
    await deprecate(r);
    expect((await cli(r, "op_017", ["major", "seal", ID])).code).toBe(EXIT.ok);
    expect((await cli(r, "op_031", ["major", "approve", ID, "--rev", "1"])).code).toBe(EXIT.ok);
    const again = await deprecate(r, ["--successor", "2", "--retires-on", "2099-06-30"]);
    expect(again.code).toBe(EXIT.ok);
    expect(again.stdout).toContain("candidate 2");
    // Show prints the approved record, the one in force, until revision 2 is sealed and approved.
    expect(await show(r)).toMatchObject({ rev: "1", state: "approved", record: { retires_on: "2099-01-31" } });
  });
});

describe("major seal, approve: roles and four eyes", () => {
  test("op_017 seals; op_031 approves", async () => {
    const r = tempRoot();
    await deprecate(r);
    expect((await cli(r, "op_017", ["major", "seal", ID])).code).toBe(EXIT.ok);
    expect((await cli(r, "op_031", ["major", "approve", ID, "--rev", "1"])).code).toBe(EXIT.ok);
    expect(await show(r)).toMatchObject({ rev: "1", state: "approved" });
  });

  test("the sealer cannot approve their own seal, even holding both roles", async () => {
    const r = rootWithDualStaff();
    await deprecate(r);
    expect((await cli(r, "op_040", ["major", "seal", ID])).code).toBe(EXIT.ok);
    const self = await cli(r, "op_040", ["major", "approve", ID, "--rev", "1"]);
    expect(self.code).toBe(EXIT.refused);
    expect(self.stderr).toContain("four eyes");
    expect(await show(r)).toMatchObject({ state: "sealed" });
    expect((await cli(r, "op_031", ["major", "approve", ID, "--rev", "1"])).code).toBe(EXIT.ok);
  });

  test("a non-reviewer cannot seal; a non-approver cannot approve", async () => {
    const r = tempRoot();
    await deprecate(r);
    expect((await cli(r, "op_031", ["major", "seal", ID])).code).toBe(EXIT.refused);
    await cli(r, "op_017", ["major", "seal", ID]);
    expect((await cli(r, "op_022", ["major", "approve", ID, "--rev", "1"])).code).toBe(EXIT.refused);
  });
});

describe("major show", () => {
  test("with no record it says the major is not deprecated", async () => {
    const r = tempRoot();
    const shown = await cli(r, "op_017", ["major", "show", ID]);
    expect(shown.code).toBe(EXIT.ok);
    expect(shown.stdout).toContain("not deprecated");
    expect(await show(r)).toMatchObject({ record: null, tenants: [] });
  });

  test("a sealed record is shown with no tenant rows: it has no force", async () => {
    const r = tempRoot();
    await deprecate(r);
    await cli(r, "op_017", ["major", "seal", ID]);
    expect(await show(r)).toMatchObject({ state: "sealed", tenants: [] });
  });

  test("approved, successor not approved here: no retire date", async () => {
    const r = tempRoot();
    await deprecate(r);
    await cli(r, "op_017", ["major", "seal", ID]);
    await cli(r, "op_031", ["major", "approve", ID, "--rev", "1"]);
    const shown = await show(r);
    expect(shown.tenants).toContainEqual({ tenant: "keystone", successor_approved_here: false, retires_on: null });
    const text = (await cli(r, "op_017", ["major", "show", ID])).stdout;
    expect(text).toContain("rev 1 (approved)");
    expect(text).toContain("no retire date");
    expect(text).toContain("2099-01-31");
  });

  test("approved, successor approved here: the tenant's retire day is the later date", async () => {
    const r = tempRoot();
    await deprecate(r, ["--successor", "2", "--retires-on", "2099-01-31"]);
    await cli(r, "op_017", ["major", "seal", ID]);
    await cli(r, "op_031", ["major", "approve", ID, "--rev", "1"]);
    // The successor's approval line, in the file layout of the score store (section 8 §5.2).
    const dir = join(r, "state", "trust", "scores", "keystone", "kvfcu", "open_share_subaccount@2.0.0", "9.2", "base");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "history.jsonl"), [batch(1, "batch_a"), approved(2)].map((l) => `${JSON.stringify(l)}\n`).join(""));
    const shown = await show(r);
    expect(shown.tenants).toContainEqual({ tenant: "keystone", successor_approved_here: true, retires_on: "2099-01-31" });
  });

  test("a major that is not app/capability@n is a usage error", async () => {
    const r = tempRoot();
    expect((await cli(r, "op_017", ["major", "show", "nonsense"])).code).toBe(EXIT.usage);
  });
});
