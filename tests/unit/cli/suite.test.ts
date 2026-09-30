// Proves `intyy suite edit | check | seal | approve` (design section 9 §8.7; section 8 §6.1).
// Roles: suite is shared (scope `*`); op_017 reviews, op_031 approves (M06 library table).
// M06 tasks 7 and 8 (the task 8 addition: `suite check`'s void-step warning, section 9 §8.7,
// against a real sealed artifact, `checkSuiteSteps`).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { FileCandidateStore } from "../../../src/adapters/files/other-stores.js";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { Artifact } from "../../../src/core/model/artifact.js";
import { CandidateDecision } from "../../../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../../../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../../../src/core/model/candidate-runs.js";
import type { CandidateFiles } from "../../../src/core/recorder/candidates.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { SIGN_IN } from "../replay/executor-harness.js";
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

/** Seals `SIGN_IN` (its own real, single step `click_login`) into `r`'s real candidate store,
 * at the same files `ctx.wiring.candidates` reads (mirrors wiring.ts's own directory layout). */
async function sealSignInArtifact(r: string): Promise<void> {
  const store = new FileCandidateStore<CandidateFiles, CandidateDecision>(
    {
      files: { "runs.json": CandidateRuns, "candidate.json": Artifact, "issues.json": CandidateIssues },
      decision: CandidateDecision,
    },
    {
      dir: join(r, "library", "candidates"),
      artifactsDir: join(r, "library", "artifacts"),
      tmpDir: join(r, "state", "var", "tmp"),
    },
    new SteppingClock(),
  );
  const sealed = await store.seal("kvfcu/sign_in/cand_2026-01-15_1000000001", "1.0.0", "op_017", SIGN_IN, {});
  if (!sealed.ok) throw new Error("test setup: sign_in seal failed");
}

const SIGN_IN_CAP = "kvfcu/sign_in@1";

describe("suite check: the void-step warning against a sealed artifact (section 9 §8.7)", () => {
  test("an extra case naming a step missing from the sealed version warns, but still passes", async () => {
    const r = tempRoot();
    await sealSignInArtifact(r);
    // sign_in's own real steps hold only `click_login` (tests/fixtures/replay/sign_in.json):
    // `click_confirm` is missing from it.
    await editWith(r, "op_017", SIGN_IN_CAP, {
      ...suiteBody(),
      capability: SIGN_IN_CAP,
      extra: [
        {
          id: "extra_missing_step",
          class: "valid",
          faults: [{ kind: "server_error", at: "@step:click_confirm" }],
          expect: { status: "success" },
        },
      ],
    });
    const checked = await cli(r, "op_017", ["suite", "check", SIGN_IN_CAP]);
    expect(checked.code).toBe(EXIT.ok);
    expect(checked.stdout).toContain(
      "warning: void_step: extra extra_missing_step names step click_confirm, missing from the sealed version",
    );
  });

  test("no sealed artifact yet: the check runs clean, with no void-step warning", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", SIGN_IN_CAP, {
      ...suiteBody(),
      capability: SIGN_IN_CAP,
      extra: [
        {
          id: "extra_missing_step",
          class: "valid",
          faults: [{ kind: "server_error", at: "@step:click_confirm" }],
          expect: { status: "success" },
        },
      ],
    });
    const checked = await cli(r, "op_017", ["suite", "check", SIGN_IN_CAP]);
    expect(checked.code).toBe(EXIT.ok);
    expect(checked.stdout).not.toContain("warning:");
  });
});
