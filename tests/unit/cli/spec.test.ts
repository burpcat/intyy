// Proves `spec new | edit | check` end to end in a temporary data root: the skeleton, the role,
// the checks, and that a bad edit is not saved. Design section 9 §8.1; section 6 §6, §7.2.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { call as rawCall, cleanRoots, tempRoot } from "./helpers.js";

afterAll(cleanRoots);

/** A temporary root with the repo's approved policy and settings. */
function root(): string {
  const r = tempRoot();
  for (const d of ["policy", "settings"])
    cpSync(join("library", d), join(r, "library", d), { recursive: true });
  return r;
}

/** Runs a real command as `staff`. */
function call(r: string, staff: string, argv: string[], env: Record<string, string> = {}) {
  return rawCall(argv, { cwd: r, env: { INTYY_STAFF: staff, ...env }, deps: { commands } });
}

/** The spec file's path in a root. */
const file = (r: string) => join(r, "library", "specs", "kvfcu", "sign_in.json");

describe("spec commands", () => {
  test("new writes a skeleton once; it fails check until the goal is written", async () => {
    const r = root();
    const made = await call(r, "op_017", ["spec", "new", "kvfcu/sign_in"]);
    expect(made.code).toBe(0);
    const doc = JSON.parse(readFileSync(file(r), "utf8")) as Record<string, unknown>;
    expect(doc).toMatchObject({
      schema: "intyy.runspec/1.0",
      caller: { tenant: "keystone", agent_id: "op_017" },
      capability: "sign_in",
      prompt: "discovery@1.0",
    });
    expect((await call(r, "op_017", ["spec", "new", "kvfcu/sign_in"])).code).toBe(EXIT.refused);
    const empty = await call(r, "op_031", ["spec", "check", "kvfcu/sign_in"]);
    expect(empty.code).toBe(EXIT.invalid);
    expect(empty.stderr).toContain("goal");
    writeFileSync(file(r), JSON.stringify({ ...doc, goal: "Sign in and reach the home page." }));
    const checked = await call(r, "op_031", ["spec", "check", "kvfcu/sign_in"]);
    expect(checked.stderr).toBe("");
    expect(checked.stdout).toBe("spec kvfcu/sign_in is valid.\n");
  });

  // M05 task 11: `--session` and `--negative` write the two fields a fresh skeleton cannot
  // guess (section 6 §5.5); a dotted variant name, like `open_share_subaccount.missing`, is
  // the same capability's alternate scenario file (docs/decisions.md, M05).
  test("new --session and --negative write a linked, negative_discovery skeleton", async () => {
    const r = root();
    const made = await call(r, "op_017", [
      "spec",
      "new",
      "kvfcu/open_share_subaccount.missing",
      "--session",
      "kvfcu/sign_in@1",
      "--negative",
    ]);
    expect(made.code).toBe(0);
    const path = join(r, "library", "specs", "kvfcu", "open_share_subaccount.missing.json");
    const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(doc).toMatchObject({
      kind: "negative_discovery",
      capability: "open_share_subaccount",
      session: "kvfcu/sign_in@1",
      goal: "",
    });
  });

  test("new writes an empty goal on a plain skeleton too", async () => {
    const r = root();
    await call(r, "op_017", ["spec", "new", "kvfcu/sign_in"]);
    const doc = JSON.parse(readFileSync(file(r), "utf8")) as Record<string, unknown>;
    expect(doc).toMatchObject({ goal: "", session: null, kind: "discovery" });
  });

  test("new refuses a --session value that is not app/capability@major", async () => {
    const r = root();
    const bad = await call(r, "op_017", ["spec", "new", "kvfcu/sign_in", "--session", "not-a-link"]);
    expect(bad.code).toBe(EXIT.usage);
  });

  test("new needs the operator role", async () => {
    expect((await call(root(), "op_031", ["spec", "new", "kvfcu/sign_in"])).code).toBe(
      EXIT.refused,
    );
  });

  test("check lists every problem at once with exit 7", async () => {
    const r = root();
    await call(r, "op_017", ["spec", "new", "kvfcu/sign_in"]);
    const doc = JSON.parse(readFileSync(file(r), "utf8")) as Record<string, unknown>;
    doc.expected_effect = "commits";
    doc.goal = "Find {input.member_id}.";
    writeFileSync(file(r), JSON.stringify(doc));
    const bad = await call(r, "op_017", ["spec", "check", "kvfcu/sign_in"]);
    expect(bad.code).toBe(EXIT.invalid);
    expect(bad.stderr).toContain("goal: {input.member_id} is not an input");
    expect(bad.stderr).toContain("correlation: a commits run needs notes or none");
  });

  test("edit saves a good edit and keeps the file unchanged after a bad one", async () => {
    const r = root();
    await call(r, "op_017", ["spec", "new", "kvfcu/sign_in"]);
    const doc = JSON.parse(readFileSync(file(r), "utf8")) as Record<string, unknown>;
    const good = join(r, "good.json");
    writeFileSync(good, JSON.stringify({ ...doc, goal: "Sign in and reach the home page." }));
    const saved = await call(r, "op_017", ["spec", "edit", "kvfcu/sign_in"], {
      EDITOR: `cp "${good}"`,
    });
    expect(saved.code).toBe(0);
    expect(readFileSync(file(r), "utf8")).toContain("Sign in and reach the home page.");

    const bad = join(r, "bad.json");
    writeFileSync(bad, JSON.stringify({ ...doc, entry: "no-slash" }));
    const before = readFileSync(file(r), "utf8");
    const refused = await call(r, "op_017", ["spec", "edit", "kvfcu/sign_in"], {
      EDITOR: `cp "${bad}"`,
    });
    expect(refused.code).toBe(EXIT.invalid);
    expect(refused.stderr).toContain("The edit is kept at");
    expect(readFileSync(file(r), "utf8")).toBe(before);
  });
});
