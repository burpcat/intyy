// Proves `candidate new | list | show | issues | decide | review`, and that `discover` records
// a candidate at the end of a successful run. Design section 9 §8.1, §8.2; section 6 §14, §15.
// Synthetic values only. No canary member.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { wire as realWire } from "../../../src/cli/wiring.js";
import { FileEvidenceStore } from "../../../src/adapters/files/other-stores.js";
import { policyKind, settingsKind } from "../../../src/core/model/kinds.js";
import { AppPolicy, type Policy } from "../../../src/core/model/policy.js";
import type { Settings } from "../../../src/core/model/settings.js";
import type { Masked } from "../../../src/ports/masked.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { FakeDocumentStore } from "../../../src/fakes/stores.js";
import { FakeMarker } from "../../../src/fakes/marker.js";
import { FakeOperator } from "../../../src/fakes/operator.js";
import { ScriptedPlanner } from "../../../src/fakes/scripted-planner.js";
import { snapshotFactory } from "../../../src/fakes/snapshot-surface/index.js";
import type { Planner } from "../../../src/ports/models.js";
import type { FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import {
  APP_LAYER,
  GLOBAL_LAYER,
  SETTINGS,
  SIGN_IN_STEPS,
  SITE,
  TENANT_LAYER,
} from "../discovery/run-kit.js";
import { call, cleanRoots, tempRoot, type Call } from "./helpers.js";

afterAll(cleanRoots);

const RUN_ID = "run_2026-09-24_g01den0001";
const LOG_DIR = fileURLToPath(new URL("../../fixtures/logs/golden/", import.meta.url));

function maskedCast<T>(v: T): Masked<T> {
  return v as Masked<T>;
}

/** Every fixture line, already `JSON.parse`d. */
function loadLines(name: string): Record<string, unknown>[] {
  return readFileSync(`${LOG_DIR}${name}`, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Writes a finished, positive `sign_in` run folder into `root`, reusing the recorder golden
 * fixture's log (tests/fixtures/logs/golden/), plus the a11y and `llm/` files a real run would
 * also leave behind, so `candidate new` reads back real snapshot content, not just the log.
 * `irreversibleClick`: the rules class `click_login`'s own gate line as `irreversible` instead
 * of `idempotent`, so a reviewer lowering it needs a second look (section 8 §10.2). */
async function seedRun(
  root: string,
  tenant: string,
  runId: string,
  opts: { irreversibleClick?: boolean } = {},
): Promise<void> {
  const evidence = new FileEvidenceStore({
    root: `${root}/state/evidence`,
    tmpDir: `${root}/state/var/tmp`,
  });
  const created = await evidence.createRun(tenant, runId);
  if (!created.ok) throw new Error("createRun failed");
  const folder = created.value;

  for (const line of loadLines("events.jsonl")) {
    if (line.event === "observation") {
      const step = line.step as string;
      const turn = Number(/^t(\d+)$/.exec(step)?.[1]);
      const file = `a11y/t${String(turn)}.yaml`;
      (line.data as Record<string, unknown>).files = [file];
      await folder.writeFile(file, maskedCast(readFileSync(`${LOG_DIR}a11y/t${String(turn)}.yaml`, "utf8")));
    }
    if (opts.irreversibleClick === true && line.event === "gate" && line.step === "t3") {
      (line.data as Record<string, unknown>).risk = "irreversible";
    }
    await folder.appendEvent(maskedCast(line));
  }

  // The `done` turn's wire request (section 9 §5.3): its one user message holds the masked
  // element list the proof IDs point into.
  const elementList = readFileSync(`${LOG_DIR}element-list-t4.txt`, "utf8");
  const request = { messages: [{ role: "user", content: [{ type: "text", text: elementList }] }] };
  await folder.writeFile("llm/00011_planner_request.json", maskedCast(JSON.stringify(request)));
  // The golden fixture's `click_login` action fingerprints a crop at this path (section 2 §13.2).
  await folder.writeFile("crops/00009_e4.png", maskedCast(Uint8Array.from([137, 80, 78, 71])));

  await folder.writeRunJson(
    maskedCast({
      schema: "intyy.run/1.0",
      run_id: runId,
      tenant,
      kind: "discovery",
      capability: "kvfcu/sign_in",
      status: "success",
      code: null,
      started_at: "2026-09-24T10:00:00.000Z",
      ended_at: "2026-09-24T10:00:08.000Z",
      counts: { turns: 4, actions: 3, blocked: 0, invalid: 0 },
    }),
  );
}

/** The spec `library/specs/kvfcu/sign_in.json` needs (matches the golden fixture's run). */
function writeSignInSpec(root: string): void {
  mkdirSync(`${root}/library/specs/kvfcu`, { recursive: true });
  writeFileSync(
    `${root}/library/specs/kvfcu/sign_in.json`,
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
}

/** A root with approved settings (so `recorderContext` finds the app's version), a spec, and a
 * finished positive run. */
async function root(opts: { irreversibleClick?: boolean } = {}): Promise<string> {
  const r = tempRoot();
  cpSync(join("library", "settings"), join(r, "library", "settings"), { recursive: true });
  writeSignInSpec(r);
  await seedRun(r, "keystone", RUN_ID, opts);
  return r;
}

const cli = (r: string, staff: string, argv: string[]) =>
  call(argv, { cwd: r, env: { INTYY_STAFF: staff }, deps: { commands } });

/** Records the seeded run and returns the new candidate's ID. */
async function newCandidate(r: string, staff = "op_017"): Promise<string> {
  const got = await cli(r, staff, ["candidate", "new", RUN_ID, "--json"]);
  return (JSON.parse(got.stdout) as { candidate: string }).candidate;
}

describe("candidate new, list, show, issues", () => {
  test("new records a finished run; list, show, and issues read it back", async () => {
    const r = await root();
    const created = await cli(r, "op_017", ["candidate", "new", RUN_ID, "--json"]);
    expect(created.code).toBe(EXIT.ok);
    const data = JSON.parse(created.stdout) as { candidate: string; blocking: number; warnings: number };
    expect(data.candidate).toMatch(/^kvfcu\/sign_in\/cand_\d{4}-\d{2}-\d{2}_[0-9a-hjkmnp-tv-z]{10}$/);
    expect(data.blocking).toBe(10);
    expect(data.warnings).toBe(2);
    const id = data.candidate;

    const listed = await cli(r, "op_017", ["candidate", "list", "--json"]);
    expect((JSON.parse(listed.stdout) as { candidates: string[] }).candidates).toEqual([id]);

    const shown = await cli(r, "op_017", ["candidate", "show", id, "--json"]);
    const shownData = JSON.parse(shown.stdout) as { artifact: { steps: { id: string }[] } };
    expect(shownData.artifact.steps.map((s) => s.id)).toEqual([
      "type_user_id",
      "type_password",
      "click_login",
    ]);

    const issues = await cli(r, "op_017", ["candidate", "issues", id, "--json"]);
    const issuesData = JSON.parse(issues.stdout) as { issues: { code: string }[] };
    expect(issuesData.issues.filter((i) => i.code === "undecided_tag")).toHaveLength(3);
  });
});

describe("candidate decide", () => {
  test("tagging an action clears its undecided_tag issue", async () => {
    const r = await root();
    const id = await newCandidate(r);

    const decided = await cli(r, "op_017", [
      "candidate",
      "decide",
      id,
      "tag",
      `${RUN_ID}#3`,
      "flow_step",
      "--json",
    ]);
    expect(decided.code).toBe(EXIT.ok);
    const after = JSON.parse(decided.stdout) as { blocking: number };
    expect(after.blocking).toBe(9);

    const issues = JSON.parse((await cli(r, "op_017", ["candidate", "issues", id, "--json"])).stdout) as {
      issues: { code: string; subject?: string }[];
    };
    expect(issues.issues.some((i) => i.code === "undecided_tag" && i.subject === "provenance.actions[0]")).toBe(
      false,
    );
    expect(issues.issues.filter((i) => i.code === "undecided_tag")).toHaveLength(2);
  });

  test("a non-reviewer is refused", async () => {
    const r = await root();
    const id = await newCandidate(r);
    // op_031 is only an approver (tests/unit/cli/helpers.ts STAFF), never a reviewer.
    const got = await cli(r, "op_031", ["candidate", "decide", id, "tag", `${RUN_ID}#3`, "flow_step"]);
    expect(got.code).toBe(EXIT.refused);
  });

  test("an unknown decision subject is refused", async () => {
    const r = await root();
    const id = await newCandidate(r);
    const got = await cli(r, "op_017", ["candidate", "decide", id, "risk", "not_a_real_step", "irreversible"]);
    expect(got.code).toBe(EXIT.usage);
    expect(got.stderr).toContain("not a known risk subject");
  });

  test("a shown (renamed) step ID maps back to its original for a later decision", async () => {
    const r = await root();
    const id = await newCandidate(r);

    const renamed = await cli(r, "op_017", [
      "candidate",
      "decide",
      id,
      "edit",
      "steps.click_login.id",
      "confirm_login",
    ]);
    expect(renamed.code).toBe(EXIT.ok);

    // The step now shows as `confirm_login`; a `risk` decision must still resolve, mapped back
    // to the original `click_login` (docs/decisions.md, M04).
    const risked = await cli(r, "op_017", ["candidate", "decide", id, "risk", "confirm_login", "idempotent"]);
    expect(risked.code).toBe(EXIT.ok);

    const shown = JSON.parse((await cli(r, "op_017", ["candidate", "show", id, "--json"])).stdout) as {
      artifact: { steps: { id: string; risk: string }[] };
    };
    const step = shown.artifact.steps.find((s) => s.id === "confirm_login");
    expect(step?.risk).toBe("idempotent");

    const issues = JSON.parse((await cli(r, "op_017", ["candidate", "issues", id, "--json"])).stdout) as {
      issues: { code: string; subject?: string }[];
    };
    expect(issues.issues.some((i) => i.code === "risk_undecided" && i.subject === "confirm_login")).toBe(false);
  });

  test("--note comes from piped standard input, never a flag", async () => {
    const r = await root();
    const id = await newCandidate(r);
    const got = await call(["candidate", "decide", id, "tag", `${RUN_ID}#3`, "flow_step"], {
      cwd: r,
      env: { INTYY_STAFF: "op_017" },
      deps: { commands },
      stdin: "Confirmed with the reviewer on the call.",
    });
    expect(got.code).toBe(EXIT.ok);
  });
});

describe("candidate review", () => {
  test("refuses off a terminal, naming decide instead", async () => {
    const r = await root();
    const id = await newCandidate(r);
    const got = await cli(r, "op_017", ["candidate", "review", id]);
    expect(got.code).toBe(EXIT.usage);
    expect(got.stderr).toContain("intyy candidate decide");
  });

  /** Section 2 §10: "A human confirms paths at review." The walk asks for `runs_on.paths`
   * before its first blocking issue; every later prompt this run needs is left unscripted, so
   * it answers blank (helpers.ts's `question()` default) and keeps each drafted value. */
  test("review asks to confirm runs_on.paths first, and a pasted list edits it", async () => {
    const r = await root();
    const id = await newCandidate(r);
    const got = await call(["candidate", "review", id], {
      cwd: r,
      env: { INTYY_STAFF: "op_017" },
      deps: { commands },
      stdinTty: true,
      answers: [JSON.stringify(["/", "/login.do", "/main.do", "/extra"])],
    });
    expect(got.code).toBe(EXIT.ok);
    const shown = await cli(r, "op_017", ["candidate", "show", id, "--json"]);
    const data = JSON.parse(shown.stdout) as { artifact: { runs_on: { paths: string[] } } };
    expect(data.artifact.runs_on.paths).toEqual(["/", "/login.do", "/main.do", "/extra"]);
  });

  test("review keeps runs_on.paths when the confirmation answer is blank", async () => {
    const r = await root();
    const id = await newCandidate(r);
    const before = await cli(r, "op_017", ["candidate", "show", id, "--json"]);
    const beforePaths = (JSON.parse(before.stdout) as { artifact: { runs_on: { paths: string[] } } }).artifact
      .runs_on.paths;
    const got = await call(["candidate", "review", id], {
      cwd: r,
      env: { INTYY_STAFF: "op_017" },
      deps: { commands },
      stdinTty: true,
      answers: [""],
    });
    expect(got.code).toBe(EXIT.ok);
    const shown = await cli(r, "op_017", ["candidate", "show", id, "--json"]);
    const data = JSON.parse(shown.stdout) as { artifact: { runs_on: { paths: string[] } } };
    expect(data.artifact.runs_on.paths).toEqual(beforePaths);
  });
});

/** The spec `library/specs/kvfcu/find_member.json` needs: a negative run on SITE that reports
 * "not found" from the sign-in page itself (section 6 §6.1, negative runs take no outputs). */
function writeFindMemberSpec(root: string): void {
  mkdirSync(`${root}/library/specs/kvfcu`, { recursive: true });
  writeFileSync(
    `${root}/library/specs/kvfcu/find_member.json`,
    JSON.stringify({
      schema: "intyy.runspec/1.0",
      kind: "negative_discovery",
      caller: { tenant: "keystone", agent_id: "op_017" },
      app: "kvfcu",
      capability: "find_member",
      goal: "Look up a member who does not exist.",
      inputs: [],
      outputs: [],
      expected_effect: "read_only",
      expected_outcome: { code: "not_found", description: "No such member." },
      session: null,
      entry: "/",
      model: "claude-sonnet-5",
      prompt: "discovery@1.0",
    }),
  );
}

/** Seals and approves `docs` into a fresh in-memory policy store. */
async function sealedPolicyStore(docs: readonly Policy[]): Promise<FakeDocumentStore<Policy>> {
  const clock = new SteppingClock("2026-09-28T14:00:00.000Z");
  const policy = new FakeDocumentStore<Policy>(policyKind, clock);
  // Why strip `approved`: GLOBAL_LAYER is read from the real, already-approved sealed file
  // (tests/unit/discovery/run-kit.ts); a candidate may carry no approval yet.
  for (const raw of docs) {
    const doc = { ...raw, approved: undefined } as Policy;
    await policy.putCandidate(policyKind.idOf?.(doc) ?? "", doc);
    const sealed = await policy.seal(policyKind.idOf?.(doc) ?? "", "op_017");
    if (!sealed.ok) throw new Error("policy seal failed in test setup");
    await policy.approve(policyKind.idOf?.(doc) ?? "", sealed.value.rev, "op_022");
  }
  return policy;
}

/** A root, plus approved policy and settings document stores matching SITE (docs/decisions.md,
 * M04: the CLI's `--candidate` gating tests need a real `discover` run, not just its refusals). */
async function discoverRoot(): Promise<{ root: string; policy: FakeDocumentStore<Policy>; settings: FakeDocumentStore<Settings> }> {
  const root = tempRoot();
  const policy = await sealedPolicyStore([GLOBAL_LAYER, APP_LAYER, TENANT_LAYER]);
  const clock = new SteppingClock("2026-09-28T14:00:01.000Z");
  const settings = new FakeDocumentStore<Settings>(settingsKind, clock);
  await settings.putCandidate("keystone", SETTINGS);
  const sealedSettings = await settings.seal("keystone", "op_017");
  if (!sealedSettings.ok) throw new Error("settings seal failed in test setup");
  await settings.approve("keystone", sealedSettings.value.rev, "op_022");
  return { root, policy, settings };
}

/** A kvfcu app layer matching the golden `sign_in` fixture's own visited paths and secrets, for
 * `candidate seal`'s CLI-level tests (unlike `APP_LAYER`, which matches SITE instead). */
const SEAL_APP_LAYER = AppPolicy.parse({
  schema: "intyy.policy/1.0",
  scope: { level: "app", app: "kvfcu" },
  revision: 1,
  reason: "Seal test app layer.",
  paths: { allow: ["/", "/login.do", "/main.do"], deny: ["/__test__/*"], irreversible: [], case_sensitive: true },
  secrets: {
    operator_username: { kind: "username", paths: ["/login.do"] },
    operator_password: { kind: "password", paths: ["/login.do"] },
  },
});

/** Runs `intyy candidate ...` with a fake policy store; everything else is the real `wire()`. */
function sealCli(r: string, staff: string, argv: string[], policy: FakeDocumentStore<Policy>): Promise<Call> {
  return call(argv, {
    cwd: r,
    env: { INTYY_STAFF: staff },
    deps: { commands, wire: (root, config, env) => ({ ...realWire(root, config, env), policy }) },
  });
}

/** Runs `intyy discover <argv...>` with a fake browser, marker, planner, and operator, over a
 * real evidence and candidate store (the real `wire()`, with only policy, settings, and the
 * discovery ports swapped). */
function discoverCall(
  env: { root: string; policy: FakeDocumentStore<Policy>; settings: FakeDocumentStore<Settings> },
  argv: string[],
  planner: Planner,
  site: FakeSite,
): Promise<Call> {
  return call(["discover", ...argv, "--json"], {
    cwd: env.root,
    env: {
      INTYY_STAFF: "op_017",
      ANTHROPIC_API_KEY: "test-key-unused",
      INTYY_KEYSTONE_KVFCU_OPERATOR_USERNAME: "teller-one",
      INTYY_KEYSTONE_KVFCU_OPERATOR_PASSWORD: "Kvfcu-test-pass-5521",
    },
    deps: {
      commands,
      wire: (root, config, wireEnv) => ({
        ...realWire(root, config, wireEnv),
        policy: env.policy,
        settings: env.settings,
        discovery: {
          surface: () => snapshotFactory(site),
          marker: () => new FakeMarker(),
          planner: () => planner,
          operator: () => new FakeOperator([]),
        },
      }),
    },
  });
}

describe("discover records a candidate", () => {
  test("a positive spec that ends success creates a new candidate", async () => {
    const env = await discoverRoot();
    writeSignInSpec(env.root);
    const got = await discoverCall(env, ["kvfcu/sign_in"], new ScriptedPlanner(SIGN_IN_STEPS), SITE);

    expect(got.code).toBe(EXIT.ok);
    const data = JSON.parse(got.stdout) as { status: string; candidate: string };
    expect(data.status).toBe("success");
    expect(data.candidate).toMatch(/^kvfcu\/sign_in\/cand_/);
  });

  test("a positive spec that ends failed records nothing", async () => {
    const env = await discoverRoot();
    writeSignInSpec(env.root);
    // An empty script hits `stuck` on turn 1; the default fake operator answers `end_run`.
    const got = await discoverCall(env, ["kvfcu/sign_in"], new ScriptedPlanner([]), SITE);

    const data = JSON.parse(got.stdout) as { status: string; candidate?: string };
    expect(data.status).toBe("failed");
    expect(data.candidate).toBeUndefined();
    expect(existsSync(join(env.root, "library", "candidates"))).toBe(false);
  });

  test("a negative spec that ends business_outcome attaches to --candidate", async () => {
    const env = await discoverRoot();
    writeSignInSpec(env.root);
    writeFindMemberSpec(env.root);
    const positive = await discoverCall(env, ["kvfcu/sign_in"], new ScriptedPlanner(SIGN_IN_STEPS), SITE);
    const id = (JSON.parse(positive.stdout) as { candidate: string }).candidate;

    const negativePlanner = new ScriptedPlanner([
      { name: "report_outcome", input: { summary: "No such member.", proof: ["e1"] } },
    ]);
    const got = await discoverCall(env, ["kvfcu/find_member", "--candidate", id], negativePlanner, SITE);

    expect(got.code).toBe(EXIT.businessOutcome);
    const data = JSON.parse(got.stdout) as { status: string; candidate: string };
    expect(data.status).toBe("business_outcome");
    expect(data.candidate).toBe(id);
  });

  test("a negative spec without --candidate is refused before the browser opens", async () => {
    const env = await discoverRoot();
    writeFindMemberSpec(env.root);
    const got = await discoverCall(env, ["kvfcu/find_member"], new ScriptedPlanner([]), SITE);
    expect(got.code).toBe(EXIT.usage);
    expect(got.stderr).toContain("--candidate");
  });

  test("a positive spec with --candidate is refused before the browser opens", async () => {
    const env = await discoverRoot();
    writeSignInSpec(env.root);
    const got = await discoverCall(
      env,
      ["kvfcu/sign_in", "--candidate", "kvfcu/sign_in/cand_2026-09-24_0000000000"],
      new ScriptedPlanner([]),
      SITE,
    );
    expect(got.code).toBe(EXIT.usage);
    expect(got.stderr).toContain("--candidate");
  });
});

/** Runs the sign_in positive discovery, then the find_member negative discovery attached to
 * it (section 6 §15's table); returns the shared candidate ID. `find_member`'s spec never
 * navigates before `report_outcome`, so the negative run's own saved screen is SITE's `/`
 * page: "Teller Sign In". */
async function candidateWithNegativeRun(env: {
  root: string;
  policy: FakeDocumentStore<Policy>;
  settings: FakeDocumentStore<Settings>;
}): Promise<string> {
  // Why: `candidate adopt` and `pack ...` read settings and packs off the real, file-backed
  // wire() (unlike `discover`, whose own wiring is swapped above), so they need the real
  // approved settings on disk, not just `env.settings`'s in-memory fake.
  cpSync(join("library", "settings"), join(env.root, "library", "settings"), { recursive: true });
  writeSignInSpec(env.root);
  writeFindMemberSpec(env.root);
  const positive = await discoverCall(env, ["kvfcu/sign_in"], new ScriptedPlanner(SIGN_IN_STEPS), SITE);
  const id = (JSON.parse(positive.stdout) as { candidate: string }).candidate;
  // Why replay the positive run's first step: `alignNegativeRun` (section 6 §14.8) needs at
  // least one step in common with the candidate's own steps before the recorder drafts an
  // outcome at all; with none, it is only a blocking `failed_alignment` issue.
  const firstStep = SIGN_IN_STEPS[0];
  if (firstStep === undefined) throw new Error("SIGN_IN_STEPS is empty");
  const negativePlanner = new ScriptedPlanner([
    firstStep,
    { name: "report_outcome", input: { summary: "No such member.", proof: ["e1"] } },
  ]);
  await discoverCall(env, ["kvfcu/find_member", "--candidate", id], negativePlanner, SITE);
  return id;
}

/** One global-scope pack, sealed and approved through the real CLI (the `EDITOR: cp` trick),
 * with one handler whose detector matches `detectorText` (`text_visible`, `contains`). */
async function sealGlobalPack(r: string, handlerId: string, detectorText: string): Promise<void> {
  const body = {
    schema: "intyy.pack/1.0",
    scope: { level: "global" },
    revision: 1,
    reason: "Test pack for candidate adopt.",
    targets: [{ id: "any_button", description: "Any button", clues: { role: "button" } }],
    conditions: [
      { id: `${handlerId}_shown`, check: "text_visible", description: "The screen is showing", text: detectorText, match: "contains" },
    ],
    handlers: [
      {
        id: handlerId,
        description: "A pack handler for the adopt test.",
        class: "recoverable",
        detector: `${handlerId}_shown`,
        response: [{ type: "click", target: "any_button", risk: "idempotent" }],
        limits: { per_step: 1, per_run: 1 },
        on_exhausted: { class: "hard_failure", failure: "app_error" },
        fixtures: { fire: [`${handlerId}_fire`], no_fire: [`${handlerId}_near_miss`] },
      },
    ],
    provenance: { runs: [], decisions: [], sealed: null },
  };
  const editedPath = join(r, `pack-edited-${String(Math.random()).slice(2)}.json`);
  writeFileSync(editedPath, JSON.stringify(body));
  await call(["pack", "edit", "global"], {
    cwd: r,
    env: { INTYY_STAFF: "op_017", EDITOR: `cp "${editedPath}"` },
    deps: { commands },
  });
  await cli(r, "op_022", ["pack", "second-look", "global", `${handlerId}.response[0]`, "--agree"]);
  const sealed = await cli(r, "op_022", ["pack", "seal", "global", "--json"]);
  const rev = (JSON.parse(sealed.stdout) as { rev: string }).rev;
  await cli(r, "op_031", ["pack", "approve", "global", "--rev", rev]);
}

/** One global-scope pack with one `business_outcome`-class handler: only that class can be
 * adopted (section 5 §9.2; `copyHandlerOutcome`, src/core/recorder/decide.ts). No response
 * action, so no risk decision or second look is needed to seal it. */
async function sealGlobalOutcomePack(
  r: string,
  handlerId: string,
  detectorText: string,
  outcome: { code: string; description: string },
): Promise<void> {
  const body = {
    schema: "intyy.pack/1.0",
    scope: { level: "global" },
    revision: 1,
    reason: "Test pack for candidate adopt.",
    targets: [],
    conditions: [
      { id: `${handlerId}_shown`, check: "text_visible", description: "The screen is showing", text: detectorText, match: "contains" },
    ],
    handlers: [
      {
        id: handlerId,
        description: "A business_outcome pack handler for the adopt test.",
        class: "business_outcome",
        detector: `${handlerId}_shown`,
        outcome,
        fixtures: { fire: [`${handlerId}_fire`], no_fire: [`${handlerId}_near_miss`] },
      },
    ],
    provenance: { runs: [], decisions: [], sealed: null },
  };
  const editedPath = join(r, `pack-edited-${String(Math.random()).slice(2)}.json`);
  writeFileSync(editedPath, JSON.stringify(body));
  await call(["pack", "edit", "global"], {
    cwd: r,
    env: { INTYY_STAFF: "op_017", EDITOR: `cp "${editedPath}"` },
    deps: { commands },
  });
  const sealed = await cli(r, "op_022", ["pack", "seal", "global", "--json"]);
  const rev = (JSON.parse(sealed.stdout) as { rev: string }).rev;
  await cli(r, "op_031", ["pack", "approve", "global", "--rev", rev]);
}

describe("candidate adopt (section 6 §15's table)", () => {
  test("an unknown outcome code is rejected", async () => {
    const env = await discoverRoot();
    const id = await candidateWithNegativeRun(env);
    await sealGlobalPack(env.root, "sign_in_shown", "Sign In");
    const got = await cli(env.root, "op_017", ["candidate", "adopt", id, "no_such_outcome", "pack:sign_in_shown"]);
    expect(got.code).toBe(EXIT.invalid);
    expect(got.stderr).toContain("is not a known outcome");
  });

  test("a handler not in the merged pack set is rejected", async () => {
    const env = await discoverRoot();
    const id = await candidateWithNegativeRun(env);
    const got = await cli(env.root, "op_017", ["candidate", "adopt", id, "not_found", "pack:no_such_handler"]);
    expect(got.code).toBe(EXIT.invalid);
    expect(got.stderr).toContain("is not in the merged pack set");
  });

  test("a handler whose detector does not fire on the negative run's screen is refused", async () => {
    const env = await discoverRoot();
    const id = await candidateWithNegativeRun(env);
    await sealGlobalPack(env.root, "never_fires", "This text never appears anywhere.");
    const got = await cli(env.root, "op_017", ["candidate", "adopt", id, "not_found", "pack:never_fires"]);
    expect(got.code).toBe(EXIT.refused);
    expect(got.stderr).toContain("detector does not fire");
  });

  test("the happy path: adopting copies the handler's own code, description, and detector", async () => {
    const env = await discoverRoot();
    const id = await candidateWithNegativeRun(env);
    // Only a `business_outcome` handler can be adopted (section 5 §9.2): its own `outcome`
    // block supplies the artifact's new code and description, never the `pack:<id>` value
    // itself, which stays in provenance only.
    await sealGlobalOutcomePack(env.root, "member_not_found_handler", "Sign In", {
      code: "member_not_found",
      description: "The credit union has no such member.",
    });
    const got = await cli(env.root, "op_017", ["candidate", "adopt", id, "not_found", "pack:member_not_found_handler", "--json"]);
    expect(got.code).toBe(EXIT.ok);

    const shown = await cli(env.root, "op_017", ["candidate", "show", id, "--json"]);
    expect(shown.code).toBe(EXIT.ok);
    const artifact = (
      JSON.parse(shown.stdout) as {
        artifact: {
          contract: { outcomes: { code: string; description: string; condition: string }[] };
          conditions: { id: string; description: string }[];
          provenance: { decisions: Record<string, unknown>[] };
        };
      }
    ).artifact;

    const outcome = artifact.contract.outcomes.find((o) => o.code === "member_not_found");
    if (outcome === undefined) throw new Error("member_not_found was not adopted into contract.outcomes");
    expect(outcome.description).toBe("The credit union has no such member.");
    // The condition is the handler's own detector, flattened into the artifact's own name
    // space (section 5 §9.2), never the placeholder `pack:member_not_found_handler` value.
    expect(artifact.conditions.some((c) => c.id === outcome.condition)).toBe(true);

    const decision = artifact.provenance.decisions.find((d) => d.what === "outcome_name" && d.subject === "not_found");
    if (decision === undefined) throw new Error("no outcome_name decision in provenance.decisions");
    expect(decision).toMatchObject({ value: "pack:member_not_found_handler", by: "op_017" });
  });
});

/** Resolves every review decision the golden candidate needs, deciding `click_login`'s risk as
 * `clickRisk` (a lowering, to exercise the second look, or its own rules' class to skip it). */
async function resolveBasics(r: string, id: string, clickRisk: string): Promise<void> {
  for (const seq of [3, 6, 9]) {
    await cli(r, "op_017", ["candidate", "decide", id, "tag", `${RUN_ID}#${String(seq)}`, "flow_step"]);
  }
  await cli(r, "op_017", ["candidate", "decide", id, "edit", "about.when_to_use", "Sign the operator in first."]);
  await cli(r, "op_017", ["candidate", "decide", id, "edit", "about.limits", "Operator only."]);
  await cli(r, "op_017", ["candidate", "decide", id, "risk", "type_user_id", "idempotent"]);
  await cli(r, "op_017", ["candidate", "decide", id, "risk", "type_password", "idempotent"]);
  await cli(r, "op_017", ["candidate", "decide", id, "risk", "click_login", clickRisk]);
}

describe("candidate second-look and seal, through the CLI", () => {
  test("second-look needs exactly one of --agree or --disagree", async () => {
    const r = await root({ irreversibleClick: true });
    const id = await newCandidate(r);
    await resolveBasics(r, id, "reversible");
    const neither = await cli(r, "op_022", ["candidate", "second-look", id, "click_login"]);
    expect(neither.code).toBe(EXIT.usage);
    const both = await cli(r, "op_022", ["candidate", "second-look", id, "click_login", "--agree", "--disagree"]);
    expect(both.code).toBe(EXIT.usage);
  });

  test("second-look needs the reviewer role", async () => {
    const r = await root({ irreversibleClick: true });
    const id = await newCandidate(r);
    await resolveBasics(r, id, "reversible");
    // op_031 (tests/unit/cli/helpers.ts STAFF) is only an approver, never a reviewer.
    const got = await cli(r, "op_031", ["candidate", "second-look", id, "click_login", "--agree"]);
    expect(got.code).toBe(EXIT.refused);
  });

  test("seal fails without a second look, then succeeds once another staff ID agrees", async () => {
    const r = await root({ irreversibleClick: true });
    const policy = await sealedPolicyStore([GLOBAL_LAYER, SEAL_APP_LAYER, TENANT_LAYER]);
    const id = await newCandidate(r);
    await resolveBasics(r, id, "reversible");

    const before = await sealCli(r, "op_017", ["candidate", "seal", id, "--version", "1.0.0"], policy);
    expect(before.code).toBe(EXIT.invalid);

    const sameStaff = await cli(r, "op_017", ["candidate", "second-look", id, "click_login", "--agree"]);
    expect(sameStaff.code).toBe(EXIT.refused);

    const agreed = await cli(r, "op_022", ["candidate", "second-look", id, "click_login", "--agree"]);
    expect(agreed.code).toBe(EXIT.ok);

    const sealed = await sealCli(r, "op_017", ["candidate", "seal", id, "--version", "1.0.0", "--json"], policy);
    expect(sealed.code).toBe(EXIT.ok);
    const data = JSON.parse(sealed.stdout) as { key: string };
    expect(data.key).toBe("kvfcu/sign_in@1.0.0");
  });

  test("a successful seal writes a normal fixture folder matching the run's own bytes", async () => {
    const r = await root();
    const policy = await sealedPolicyStore([GLOBAL_LAYER, SEAL_APP_LAYER, TENANT_LAYER]);
    const id = await newCandidate(r);
    await resolveBasics(r, id, "idempotent");
    const sealed = await sealCli(r, "op_017", ["candidate", "seal", id, "--version", "1.0.0"], policy);
    expect(sealed.code).toBe(EXIT.ok);

    // The golden fixture's own `/login.do` turn saved only an a11y snapshot, never a DOM or
    // screenshot capture (tests/fixtures/logs/golden/).
    const dir = join(r, "library", "fixtures", "kvfcu", "normal_login");
    expect(readFileSync(join(dir, "a11y.yaml"), "utf8")).toBe(readFileSync(`${LOG_DIR}a11y/t1.yaml`, "utf8"));
    expect(existsSync(join(dir, "dom.html"))).toBe(false);
    expect(existsSync(join(dir, "screen.png"))).toBe(false);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { missing: string[] };
    expect([...meta.missing].sort()).toEqual(["dom.html", "screen.png"]);
  });
});

/** Seals a fresh `sign_in` candidate as `1.0.0` and returns its root and library artifact path. */
async function sealSignIn(): Promise<{ r: string; policy: FakeDocumentStore<Policy>; artifactDir: string }> {
  const r = await root();
  const policy = await sealedPolicyStore([GLOBAL_LAYER, SEAL_APP_LAYER, TENANT_LAYER]);
  const id = await newCandidate(r);
  await resolveBasics(r, id, "idempotent");
  const sealed = await sealCli(r, "op_017", ["candidate", "seal", id, "--version", "1.0.0"], policy);
  if (sealed.code !== EXIT.ok) throw new Error(`test setup: seal failed: ${sealed.stderr}`);
  return { r, policy, artifactDir: join(r, "library", "artifacts", "kvfcu", "sign_in", "1.0.0") };
}

describe("artifact list, show, and verify", () => {
  test("list and show read back the sealed sign_in artifact", async () => {
    const { r } = await sealSignIn();
    const listed = await cli(r, "op_017", ["artifact", "list", "--json"]);
    expect(listed.code).toBe(EXIT.ok);
    expect(
      (JSON.parse(listed.stdout) as { artifacts: { app: string; capability: string; version: string }[] })
        .artifacts,
    ).toEqual([{ app: "kvfcu", capability: "sign_in", version: "1.0.0" }]);

    const shown = await cli(r, "op_017", ["artifact", "show", "kvfcu/sign_in@1.0.0", "--json"]);
    expect(shown.code).toBe(EXIT.ok);
    const artifact = (JSON.parse(shown.stdout) as { artifact: { identity: { version: string } } }).artifact;
    expect(artifact.identity.version).toBe("1.0.0");
  });

  test("verify passes on a freshly sealed artifact", async () => {
    const { r, policy } = await sealSignIn();
    const got = await sealCli(r, "op_017", ["artifact", "verify", "kvfcu/sign_in@1.0.0", "--json"], policy);
    expect(got.code).toBe(EXIT.ok);
    expect((JSON.parse(got.stdout) as { ok: boolean }).ok).toBe(true);
  });

  test("verify fails on a tampered artifact.json", async () => {
    const { r, policy, artifactDir } = await sealSignIn();
    const path = join(artifactDir, "artifact.json");
    const doc = JSON.parse(readFileSync(path, "utf8")) as { about: { summary: string } };
    doc.about.summary = "Tampered by hand.";
    writeFileSync(path, JSON.stringify(doc, null, 2));

    const got = await sealCli(r, "op_017", ["artifact", "verify", "kvfcu/sign_in@1.0.0", "--json"], policy);
    expect(got.code).toBe(EXIT.invalid);
    const data = JSON.parse(got.stdout) as { ok: boolean; problems: { code: string }[] };
    expect(data.ok).toBe(false);
    expect(data.problems.some((p) => p.code === "invalid")).toBe(true);
  });

  test("verify fails when a target's crop file is missing", async () => {
    const { r, policy, artifactDir } = await sealSignIn();
    const cropPath = join(artifactDir, "crops", "login_button.png");
    expect(existsSync(cropPath)).toBe(true);
    rmSync(cropPath);

    const got = await sealCli(r, "op_017", ["artifact", "verify", "kvfcu/sign_in@1.0.0", "--json"], policy);
    expect(got.code).toBe(EXIT.invalid);
    const data = JSON.parse(got.stdout) as { ok: boolean; problems: { code: string; message: string }[] };
    expect(data.ok).toBe(false);
    expect(data.problems.some((p) => p.code === "missing_crop" && p.message.includes("login_button"))).toBe(
      true,
    );
  });
});

describe("capability list and describe", () => {
  test("list and describe read the sealed sign_in artifact, draft state until M10", async () => {
    const { r } = await sealSignIn();
    const listed = await cli(r, "op_017", ["capability", "list", "--json"]);
    expect(listed.code).toBe(EXIT.ok);
    expect(
      (JSON.parse(listed.stdout) as { capabilities: { app: string; capability: string; major: number; state: string }[] })
        .capabilities,
    ).toEqual([{ app: "kvfcu", capability: "sign_in", major: 1, effect: "read_only", state: "draft" }]);
  });

  test("--format tool matches the committed golden file", async () => {
    const { r } = await sealSignIn();
    const got = await cli(r, "op_017", ["capability", "describe", "kvfcu/sign_in@1", "--format", "tool", "--json"]);
    expect(got.code).toBe(EXIT.ok);
    const tool = JSON.parse(got.stdout) as unknown;
    const golden = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../fixtures/golden/sign_in.tool.json", import.meta.url)), "utf8"),
    ) as unknown;
    expect(tool).toEqual(golden);
  });
});
