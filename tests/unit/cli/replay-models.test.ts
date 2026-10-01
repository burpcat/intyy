// Proves how `intyy replay` decides whether to build the rung 3 reviewer: `--models off` never
// builds it, a missing key variable never builds it (and says so), and policy on with a key
// does. The key is read from the variable `intyy.json` names, never from a file. Design section 5
// §10.8, §11.5; section 9 §10.1. M09 tasks 4 and 5.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { TableReviewer } from "../../../src/fakes/table-reviewer.js";
import { Config } from "../../../src/core/model/config.js";
import { cleanRoots } from "./helpers.js";
import {
  MEMBER_FOUND,
  replayCall,
  replayRoot,
  runSupervisedToEnd,
  writeAuthorization,
  writeInputs,
  type ReplayEnv,
} from "./replay-harness.js";

afterAll(cleanRoots);

// Why from config: the variable name lives in intyy.json, not in the test (CLAUDE.md).
const KEY_VAR = Config.parse(
  JSON.parse(readFileSync(new URL("../../../intyy.json", import.meta.url), "utf8")),
).model_keys.claude;

function argv(env: ReplayEnv, extra: string[]): string[] {
  const inputs = writeInputs(env, { member_id: MEMBER_FOUND });
  const auth = writeAuthorization(env, "kvfcu/open_sub@1");
  return [
    "replay",
    "kvfcu/open_sub@1",
    "--mode",
    "supervised",
    "--inputs",
    inputs,
    "--authorization",
    auth,
    "--json",
    ...extra,
  ];
}

/** Runs one replay with a reviewer spy; returns the keys it was asked to build with. */
async function keysAsked(extra: string[], env: Record<string, string | undefined>) {
  const root = await replayRoot();
  const keys: string[] = [];
  const got = await runSupervisedToEnd(root, argv(root, extra), "approved", {
    env,
    reviewer: (key) => {
      keys.push(key);
      return new TableReviewer({});
    },
  });
  return { keys, got };
}

describe("intyy replay: the reviewer is built only when allowed", () => {
  test("policy on and a key set: the reviewer is built with that key", async () => {
    const { keys, got } = await keysAsked([], { [KEY_VAR]: "test-key-not-real" });
    expect(got.code).toBe(0);
    expect(keys).toEqual(["test-key-not-real"]);
  });

  test("--models off: the reviewer is never built", async () => {
    const { keys, got } = await keysAsked(["--models", "off"], { [KEY_VAR]: "test-key-not-real" });
    expect(got.code).toBe(0);
    expect(keys).toEqual([]);
  });

  test("no key: the reviewer is not built, and the run says so without printing any key", async () => {
    const { keys, got } = await keysAsked([], { [KEY_VAR]: undefined });
    expect(got.code).toBe(0);
    expect(keys).toEqual([]);
    expect(got.stderr).toContain(KEY_VAR);
  });

  test("--models takes only the value off", async () => {
    const root = await replayRoot();
    const got = await replayCall(root, argv(root, ["--models", "on"]));
    expect(got.code).toBe(EXIT.usage);
    expect(got.stderr).toContain("--models takes one value: off");
  });
});
