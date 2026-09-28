// Proves `discover` refuses before any browser opens: no model key, no spec, no operator role.
// Design section 9 §8.1, §12.2; M03 task 11. The real run is the owner's (CLAUDE.md).
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { instanceKey } from "../../../src/cli/commands/discover.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { call as rawCall, cleanRoots, tempRoot } from "./helpers.js";

afterAll(cleanRoots);

/** A root with approved policy and settings, and a sign_in spec. */
function root(): string {
  const r = tempRoot();
  for (const d of ["policy", "settings"])
    cpSync(join("library", d), join(r, "library", d), { recursive: true });
  mkdirSync(join(r, "library", "specs", "kvfcu"), { recursive: true });
  writeFileSync(
    join(r, "library", "specs", "kvfcu", "sign_in.json"),
    JSON.stringify({
      schema: "intyy.runspec/1.0",
      kind: "discovery",
      caller: { tenant: "keystone", agent_id: "op_017" },
      app: "kvfcu",
      capability: "sign_in",
      goal: "Sign in as the operator and reach the home page.",
      inputs: [],
      outputs: [],
      expected_effect: "read_only",
      session: null,
      entry: "/",
      model: "claude-sonnet-5",
      prompt: "discovery@1.0",
    }),
  );
  return r;
}

const call = (r: string, staff: string, argv: string[], env: Record<string, string> = {}) =>
  rawCall(argv, { cwd: r, env: { INTYY_STAFF: staff, ...env }, deps: { commands } });

describe("discover", () => {
  test("with no model key it stops before a browser opens, naming the variable", async () => {
    const got = await call(root(), "op_017", ["discover", "kvfcu/sign_in"]);
    expect(got.code).toBe(EXIT.usage);
    expect(got.stderr).toContain("set ANTHROPIC_API_KEY to run discovery");
  });

  test("a missing spec and a missing role are refused", async () => {
    const r = root();
    expect((await call(r, "op_017", ["discover", "kvfcu/nope"])).code).toBe(EXIT.usage);
    expect((await call(r, "op_031", ["discover", "kvfcu/sign_in"])).code).toBe(EXIT.refused);
  });

  test("the instance lock key follows section 9 §12.2", () => {
    expect(instanceKey("http://127.0.0.1:8080")).toBe("http_127.0.0.1_8080");
  });
});
