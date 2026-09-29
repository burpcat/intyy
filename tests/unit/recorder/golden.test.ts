// The recorder golden test (section 6 §14.1: "a saved run folder plus saved decisions always
// give the same bytes"; §18, "Recorder golden test"). Fixtures: tests/fixtures/logs/golden/ (a
// synthetic sign_in-shaped log, its saved a11y snapshots, the done turn's element-list text, and
// decisions.jsonl). Expected output: tests/fixtures/golden/sign_in.candidate.json, canonical
// JSON (`canonicalJson`) of `{ candidate, issues }`.
//
// To update the golden file after a deliberate recorder change, run:
//   UPDATE_GOLDEN=1 npx vitest run tests/unit/recorder/golden.test.ts
// Any change to the golden file's bytes must also bump `RECORDER_VERSION`
// (src/core/recorder/version.ts): the same log must never silently produce different bytes
// under one recorder version.
//
// Synthetic values only. No canary member. Secrets appear only as `{secret.*}` references.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { canonicalJson } from "../../../src/core/model/canonical.js";
import { CandidateDecision } from "../../../src/core/model/candidate-decision.js";
import { RunSpec } from "../../../src/core/model/runspec.js";
import { record, type RecorderInput } from "../../../src/core/recorder/record.js";
import type { Snapshots } from "../../../src/core/recorder/steps.js";

const LOG_DIR = fileURLToPath(new URL("../../fixtures/logs/golden/", import.meta.url));
const GOLDEN_FILE = fileURLToPath(
  new URL("../../fixtures/golden/sign_in.candidate.json", import.meta.url),
);

const RUN_ID = "run_2026-09-24_g01den0001";

/** One fixture file's lines, already `JSON.parse`d. */
function loadLines(name: string): unknown[] {
  return readFileSync(`${LOG_DIR}${name}`, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

/** The golden `sign_in` run's spec: read-only, its own login, no inputs or outputs. */
function goldenSpec(): RunSpec {
  return RunSpec.parse({
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
  });
}

/** Builds the recorder's input from the golden fixture files. */
function goldenInput(): RecorderInput {
  const a11yByTurn = new Map<number, string>();
  for (const turn of [1, 2, 3, 4]) {
    a11yByTurn.set(turn, readFileSync(`${LOG_DIR}a11y/t${String(turn)}.yaml`, "utf8"));
  }
  const snapshots: Snapshots = {
    a11yByTurn,
    proof: { turn: 4, ids: ["e1"] },
    proofElementListText: readFileSync(`${LOG_DIR}element-list-t4.txt`, "utf8"),
  };
  const decisions = loadLines("decisions.jsonl").map((d) => CandidateDecision.parse(d));
  return {
    positive: { runId: RUN_ID, spec: goldenSpec(), lines: loadLines("events.jsonl"), snapshots },
    decisions,
    context: {
      tenant: "keystone",
      appVersion: "8.4",
      viewport: { width: 1280, height: 800, scale: 1 },
    },
  };
}

describe("recorder golden test", () => {
  test("a saved masked log plus decisions give the same artifact bytes", () => {
    const output = record(goldenInput());
    const actual = canonicalJson({ candidate: output.candidate, issues: output.issues });

    if (process.env.UPDATE_GOLDEN === "1") {
      writeFileSync(GOLDEN_FILE, `${JSON.stringify(JSON.parse(actual), null, 2)}\n`);
    }

    const golden = canonicalJson(JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as unknown);
    expect(actual).toBe(golden);
  });

  test("record() is deterministic: the same input always gives the same bytes", () => {
    const input = goldenInput();
    expect(canonicalJson(record(input))).toBe(canonicalJson(record(input)));
  });
});
