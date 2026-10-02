// Proves how `replayModels` (used by `intyy replay` and `intyy certify`) decides whether to build
// the rung 2 jev classifier, and which cutoffs it loads: built only when the policy switch is on,
// the run is not `--models off`, and the key variable `intyy.json` names (`model_keys.jev`) is set;
// then the app's APPROVED threshold record for the wiring's jev version fills `cutoffs`. A record
// that is only sealed, or for another version, is not used; with no record the starting values
// apply and the run says so. Temporary data roots only. Design section 5 §10.4, §10.8; section 8
// §14.1; docs/decisions.md M09 (2026-10-01: key variable TYPESAFE_API_KEY, model jev-1.13.0).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { replayModels } from "../../../src/cli/commands/replay.js";
import type { Ctx } from "../../../src/cli/context.js";
import type { Io } from "../../../src/cli/output.js";
import { wire } from "../../../src/cli/wiring.js";
import { Config } from "../../../src/core/model/config.js";
import { TableClassifier } from "../../../src/fakes/table-classifier.js";
import { TableReviewer } from "../../../src/fakes/table-reviewer.js";
import { call, cleanRoots, tempRoot } from "./helpers.js";
import { commands } from "../../../src/cli/commands/index.js";
import {
  MEMBER_FOUND,
  readRunJson,
  replayRoot,
  runSupervisedToEnd,
  writeAuthorization,
  writeInputs,
} from "./replay-harness.js";

afterAll(cleanRoots);

const APP = "kvfcu";
const VERSION = "jev-1.13.0";
const CONFIG = Config.parse(JSON.parse(readFileSync("intyy.json", "utf8")));
// Why from config: the variable name lives in intyy.json, not in the test (CLAUDE.md).
const JEV_VAR = CONFIG.model_keys.jev;
const CLAUDE_VAR = CONFIG.model_keys.claude;
const KEY = "made-up-jev-key";

const cli = (r: string, staff: string, argv: string[], extraEnv: Record<string, string> = {}) =>
  call(argv, { cwd: r, env: { INTYY_STAFF: staff, ...extraEnv }, deps: { commands } });

/** Saves a threshold record for `version` with the given cutoffs, then seals it and (optionally) approves it. */
async function record(
  r: string,
  version: string,
  cutoffs: { handler_min: number; outcome_min: number; reconciliation_min: number },
  approve: boolean,
): Promise<void> {
  const path = join(r, `edited-${version}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      schema: "intyy.thresholds/1.0",
      app: APP,
      jev_version: version,
      revision: 1,
      ...cutoffs,
    }),
  );
  const jev = ["--jev", version];
  expect((await cli(r, "op_017", ["thresholds", "edit", APP, ...jev], { EDITOR: `cp "${path}"` })).code).toBe(0);
  expect((await cli(r, "op_017", ["thresholds", "seal", APP, ...jev])).code).toBe(0);
  if (approve)
    expect((await cli(r, "op_031", ["thresholds", "approve", APP, ...jev, "--rev", "1"])).code).toBe(0);
}

const CUTOFFS = { handler_min: 0.7, outcome_min: 0.9, reconciliation_min: 0.85 };

/** Runs `replayModels` against a real file-backed data root with spy wiring for both models. */
async function build(
  r: string,
  opts: {
    env?: Record<string, string | undefined>;
    models?: string;
    jev?: boolean;
    reviewer?: boolean;
  } = {},
) {
  const jevKeys: string[] = [];
  const reviewerKeys: string[] = [];
  const classifier = new TableClassifier({});
  let stderr = "";
  const io: Io = {
    stdout: { write: () => undefined },
    stderr: { write: (t) => (stderr += t) },
    stdin: { readAll: () => Promise.resolve(""), question: () => Promise.resolve("") },
    env: opts.env ?? { [JEV_VAR]: KEY },
    cwd: r,
  };
  const ctx: Ctx = {
    io,
    root: r,
    config: CONFIG,
    tenant: CONFIG.default_tenant,
    staff: null,
    flags: {
      root: undefined,
      tenant: undefined,
      staff: undefined,
      json: false,
      revealOutputs: false,
      models: opts.models,
    },
    wiring: {
      ...wire(r, CONFIG, {}),
      classifier: (key) => {
        jevKeys.push(key);
        return classifier;
      },
      jevVersion: VERSION,
      reviewer: (key) => {
        reviewerKeys.push(key);
        return new TableReviewer({});
      },
    },
    exit: { code: 0 },
  };
  const models = await replayModels(
    ctx,
    { jev: opts.jev ?? true, reviewer: opts.reviewer ?? false },
    APP,
  );
  return { models, classifier, jevKeys, reviewerKeys, stderr: () => stderr };
}

describe("replayModels: the jev classifier is built only when allowed", () => {
  test("the key variable intyy.json names is the vendor's TYPESAFE_API_KEY", () => {
    expect(JEV_VAR).toBe("TYPESAFE_API_KEY");
  });

  test("the jev classifier follows the policy switch, the key, and --models; the reviewer's key is separate; no printed line holds a key", async () => {
    // switch on and a key set: built with that key, and the version is set
    const on = await build(tempRoot());
    expect(on.jevKeys).toEqual([KEY]);
    expect(on.models.classifier).toBe(on.classifier);
    expect(on.models.jevVersion).toBe(VERSION);
    // no printed line holds the key value
    expect(on.stderr()).not.toContain(KEY);

    // no key: not built, the run says which variable to set, and no key is printed
    const noKey = await build(tempRoot(), { env: {} });
    expect(noKey.jevKeys).toEqual([]);
    expect(noKey.models.classifier).toBeUndefined();
    expect(noKey.models.jevVersion).toBeUndefined();
    expect(noKey.stderr()).toContain("jev is off for this run");
    expect(noKey.stderr()).toContain(JEV_VAR);

    // an empty key counts as no key
    const empty = await build(tempRoot(), { env: { [JEV_VAR]: "" } });
    expect(empty.jevKeys).toEqual([]);
    expect(empty.models.classifier).toBeUndefined();

    // the policy switch off: not built, even with a key
    const off = await build(tempRoot(), { jev: false });
    expect(off.jevKeys).toEqual([]);
    expect(off.models.classifier).toBeUndefined();

    // --models off: nothing is built, and it needs no key
    const modelsOff = await build(tempRoot(), { models: "off", reviewer: true });
    expect(modelsOff.models).toEqual({ off: true });
    expect(modelsOff.jevKeys).toEqual([]);
    expect(modelsOff.reviewerKeys).toEqual([]);

    // the reviewer's key is separate: a reviewer key alone does not turn jev on
    const reviewerOnly = await build(tempRoot(), {
      env: { [CLAUDE_VAR]: "made-up-claude-key" },
      reviewer: true,
    });
    expect(reviewerOnly.reviewerKeys).toEqual(["made-up-claude-key"]);
    expect(reviewerOnly.jevKeys).toEqual([]);
    expect(reviewerOnly.models.classifier).toBeUndefined();

    // both models together
    const both = await build(tempRoot(), {
      env: { [JEV_VAR]: KEY, [CLAUDE_VAR]: "made-up-claude-key" },
      reviewer: true,
    });
    expect(both.jevKeys).toEqual([KEY]);
    expect(both.reviewerKeys).toEqual(["made-up-claude-key"]);
    expect(both.models.reviewer).toBeDefined();
    expect(both.models.classifier).toBeDefined();
  });
});

describe("replayModels: the cutoffs (section 5 §10.4, section 8 §14.1)", () => {
  test("only an approved record for this app and version fills the cutoffs; otherwise the starting values apply and the run says so", async () => {
    // an approved record for this app and version fills the cutoffs
    const r = tempRoot();
    await record(r, VERSION, CUTOFFS, true);
    const got = await build(r);
    expect(got.models.cutoffs).toEqual(CUTOFFS);
    expect(got.stderr()).not.toContain("starting thresholds");

    // with no key, no record is loaded or mentioned
    const noKey = await build(r, { env: {} });
    expect(noKey.models.cutoffs).toBeUndefined();
    expect(noKey.stderr()).not.toContain("starting thresholds");

    // no record: no cutoffs (the starting values apply), and the run says so
    const none = await build(tempRoot());
    expect(none.models.cutoffs).toBeUndefined();
    expect(none.stderr()).toContain("starting thresholds");
    expect(none.stderr()).toContain(VERSION);

    // a sealed record that is not approved is not used
    const sealedOnly = tempRoot();
    await record(sealedOnly, VERSION, CUTOFFS, false);
    const sealed = await build(sealedOnly);
    expect(sealed.models.cutoffs).toBeUndefined();
    expect(sealed.stderr()).toContain("starting thresholds");

    // an approved record for another jev version is not used
    const other = tempRoot();
    await record(other, "jev-1.12.0", CUTOFFS, true);
    const another = await build(other);
    expect(another.models.cutoffs).toBeUndefined();
  });
});

describe("intyy replay: the freeze holds the jev switch and the approved cutoffs", () => {
  const argv = (env: Awaited<ReturnType<typeof replayRoot>>) => [
    "replay",
    "kvfcu/open_sub@1",
    "--mode",
    "supervised",
    "--inputs",
    writeInputs(env, { member_id: MEMBER_FOUND }),
    "--authorization",
    writeAuthorization(env, "kvfcu/open_sub@1"),
    "--json",
  ];

  type Ladder = Record<string, unknown>;
  const ladderOf = (env: Awaited<ReturnType<typeof replayRoot>>, runId: string): Ladder => {
    // Why twice: run.json's `frozen` holds the log header, whose own `frozen` holds the run's freeze.
    return (readRunJson(env, runId) as { frozen: { frozen: { ladder: Ladder } } }).frozen.frozen.ladder;
  };

  test("a key set: the run freezes jev on with the approved record's cutoffs", async () => {
    const env = await replayRoot();
    await record(env.root, VERSION, CUTOFFS, true);
    const keys: string[] = [];
    const got = await runSupervisedToEnd(env, argv(env), "approved", {
      env: { [JEV_VAR]: KEY },
      classifier: (k) => {
        keys.push(k);
        return new TableClassifier({});
      },
      jevVersion: VERSION,
    });
    expect(got.code).toBe(0);
    expect(keys).toEqual([KEY]);
    expect(ladderOf(env, got.runId)).toMatchObject({ jev: true, ...CUTOFFS });
  });

  test("no key: the run freezes jev off and says which variable to set", async () => {
    const env = await replayRoot();
    let built = 0;
    const got = await runSupervisedToEnd(env, argv(env), "approved", {
      env: { [JEV_VAR]: undefined },
      classifier: () => {
        built++;
        return new TableClassifier({});
      },
      jevVersion: VERSION,
    });
    expect(got.code).toBe(0);
    expect(built).toBe(0);
    expect(got.stderr).toContain(JEV_VAR);
    expect(ladderOf(env, got.runId)).toMatchObject({ jev: false });
  });
});
