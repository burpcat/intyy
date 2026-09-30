// Proves sealing and the second look (section 6 §15, section 9 §8.2, §8.3, section 8 §10.2,
// section 2 §5.2, §19.4, §19.6). Fully in memory: a fake evidence, candidate, and settings
// store, seeded from the recorder golden fixture's log (tests/fixtures/logs/golden/), so every
// rule is tested at the core layer, with no CLI and no real files.
// Synthetic values only. No canary member.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { Artifact } from "../../../src/core/model/artifact.js";
import type { ArtifactCheckContext } from "../../../src/core/model/artifact-checks.js";
import { CandidateDecision } from "../../../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../../../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../../../src/core/model/candidate-runs.js";
import { RunSpec } from "../../../src/core/model/runspec.js";
import type { Settings } from "../../../src/core/model/settings.js";
import { settingsKind } from "../../../src/core/model/kinds.js";
import { recordPositiveRun, regenerateCandidate, type CandidateDeps } from "../../../src/core/recorder/candidates.js";
import { neededBump, proposeVersion, secondLook, sealCandidate } from "../../../src/core/recorder/seal.js";
import { ok, fail } from "../../../src/ports/outcome.js";
import type { Masked } from "../../../src/ports/masked.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { SeededIds } from "../../../src/fakes/ids.js";
import { FakeCandidateStore, FakeDocumentStore, FakeEvidenceStore } from "../../../src/fakes/stores.js";
import { SETTINGS } from "../discovery/run-kit.js";

const LOG_DIR = fileURLToPath(new URL("../../fixtures/logs/golden/", import.meta.url));
const RUN_ID = "run_2026-09-24_g01den0001";
const TENANT = "keystone";

function masked<T>(v: T): Masked<T> {
  return v as Masked<T>;
}

/** Every fixture line, already `JSON.parse`d. */
function loadLines(name: string): Record<string, unknown>[] {
  return readFileSync(`${LOG_DIR}${name}`, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The golden `sign_in` run's spec (section 6 §6). */
function goldenSpec(): RunSpec {
  return RunSpec.parse({
    schema: "intyy.runspec/1.0",
    kind: "discovery",
    caller: { tenant: TENANT, agent_id: "op_017" },
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

/** Writes the golden run into a fake evidence store. `irreversibleClick` classes `click_login`'s
 * own gate line as `irreversible`, so lowering it needs a second look (section 8 §10.2). */
async function seedRun(evidence: FakeEvidenceStore, runId: string, irreversibleClick = false): Promise<void> {
  const created = await evidence.createRun(TENANT, runId);
  if (!created.ok) throw new Error("createRun failed");
  const folder = created.value;
  for (const line of loadLines("events.jsonl")) {
    if (line.event === "observation") {
      const turn = Number(/^t(\d+)$/.exec(line.step as string)?.[1]);
      const file = `a11y/t${String(turn)}.yaml`;
      (line.data as Record<string, unknown>).files = [file];
      await folder.writeFile(file, masked(readFileSync(`${LOG_DIR}a11y/t${String(turn)}.yaml`, "utf8")));
    }
    if (irreversibleClick && line.event === "gate" && line.step === "t3") {
      (line.data as Record<string, unknown>).risk = "irreversible";
    }
    await folder.appendEvent(masked(line));
  }
  const elementList = readFileSync(`${LOG_DIR}element-list-t4.txt`, "utf8");
  const request = { messages: [{ role: "user", content: [{ type: "text", text: elementList }] }] };
  await folder.writeFile("llm/00011_planner_request.json", masked(JSON.stringify(request)));
  // The golden fixture's `click_login` action fingerprints a crop at this path (section 2 §13.2).
  await folder.writeFile("crops/00009_e4.png", masked(Uint8Array.from([137, 80, 78, 71])));
  await folder.writeRunJson(
    masked({
      schema: "intyy.run/1.0",
      run_id: runId,
      tenant: TENANT,
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

/** A fully in-memory `CandidateDeps`, seeded with the golden run and approved settings. */
async function testDeps(
  irreversibleClick = false,
): Promise<{ deps: CandidateDeps; clock: SteppingClock }> {
  const clock = new SteppingClock("2026-09-28T14:00:00.000Z");
  const evidence = new FakeEvidenceStore();
  await seedRun(evidence, RUN_ID, irreversibleClick);
  const candidates = new FakeCandidateStore(
    {
      files: {
        "runs.json": CandidateRuns,
        "candidate.json": Artifact,
        "issues.json": CandidateIssues,
      },
      decision: CandidateDecision,
    },
    clock,
  );
  const settings = new FakeDocumentStore<Settings>(settingsKind, clock);
  await settings.putCandidate("keystone", SETTINGS);
  const sealedSettings = await settings.seal("keystone", "op_017");
  if (!sealedSettings.ok) throw new Error("settings seal failed in test setup");
  await settings.approve("keystone", sealedSettings.value.rev, "op_022");
  const deps: CandidateDeps = {
    candidates,
    evidence,
    settings,
    ids: new SeededIds(clock),
    clock,
    specs: (app, capability) =>
      Promise.resolve(
        app === "kvfcu" && capability === "sign_in" ? ok(goldenSpec()) : fail("not_found", `${app}/${capability}`),
      ),
  };
  return { deps, clock };
}

/** Records the golden run as a brand new candidate. */
async function newCandidate(deps: CandidateDeps): Promise<string> {
  const out = await recordPositiveRun(deps, TENANT, RUN_ID);
  if (!out.ok) throw new Error(`recordPositiveRun failed: ${out.detail ?? out.failure}`);
  return out.value.id;
}

/** Resolves every review decision the golden candidate needs, except the risk on
 * `click_login`, which the caller decides (so tests can pick a lowering or not). */
async function resolveBasics(deps: CandidateDeps, id: string, clickRisk: string): Promise<void> {
  const at = deps.clock.now().toISOString();
  const decisions: CandidateDecision[] = [
    { schema: "intyy.candidate_decision/1.0", what: "tag", subject: `${RUN_ID}#3`, value: "flow_step", by: "op_017", at },
    { schema: "intyy.candidate_decision/1.0", what: "tag", subject: `${RUN_ID}#6`, value: "flow_step", by: "op_017", at },
    { schema: "intyy.candidate_decision/1.0", what: "tag", subject: `${RUN_ID}#9`, value: "flow_step", by: "op_017", at },
    { schema: "intyy.candidate_decision/1.0", what: "edit", subject: "about.when_to_use", value: "Sign the operator in first.", by: "op_017", at },
    { schema: "intyy.candidate_decision/1.0", what: "edit", subject: "about.limits", value: "Operator only.", by: "op_017", at },
    { schema: "intyy.candidate_decision/1.0", what: "risk", subject: "type_user_id", value: "idempotent", by: "op_017", at },
    { schema: "intyy.candidate_decision/1.0", what: "risk", subject: "type_password", value: "idempotent", by: "op_017", at },
    { schema: "intyy.candidate_decision/1.0", what: "risk", subject: "click_login", value: clickRisk, by: "op_017", at },
  ];
  for (const d of decisions) {
    const w = await deps.candidates.appendDecision(id, d);
    if (!w.ok) throw new Error("appendDecision failed in test setup");
  }
}

const PERMISSIVE: ArtifactCheckContext = {
  pathAllowed: (p) => ["/", "/login.do", "/main.do"].includes(p),
  secretDeclared: (name) => ["operator_username", "operator_password"].includes(name),
};

const NO_LOGIN_PATH: ArtifactCheckContext = {
  pathAllowed: (p) => ["/", "/main.do"].includes(p),
  secretDeclared: (name) => ["operator_username", "operator_password"].includes(name),
};

describe("second-look", () => {
  test("sealing fails with a pending second look; passes once another staff ID agrees", async () => {
    const { deps } = await testDeps(true);
    const id = await newCandidate(deps);
    await resolveBasics(deps, id, "reversible");

    const before = await sealCandidate(deps, id, "1.0.0", "op_017", PERMISSIVE);
    expect(before).toMatchObject({ ok: false, failure: "invalid" });
    expect(before.ok ? "" : (before.detail ?? "")).toContain("risk_second_look");

    const sameStaff = await secondLook(deps, id, "click_login", "op_017", true, undefined);
    expect(sameStaff).toMatchObject({ ok: false, failure: "rule" });

    const agreed = await secondLook(deps, id, "click_login", "op_022", true, undefined);
    expect(agreed.ok).toBe(true);

    const after = await sealCandidate(deps, id, "1.0.0", "op_017", PERMISSIVE);
    expect(after.ok).toBe(true);
  });

  test("--disagree records a risk decision of irreversible, by the second reviewer", async () => {
    const { deps } = await testDeps(true);
    const id = await newCandidate(deps);
    await resolveBasics(deps, id, "reversible");

    const disagreed = await secondLook(deps, id, "click_login", "op_022", false, undefined);
    if (!disagreed.ok) throw new Error("second-look disagree failed");
    const step = disagreed.value.candidate.steps.find((s) => s.id === "click_login");
    expect(step?.risk).toBe("irreversible");
  });
});

describe("sealCandidate", () => {
  test("refuses while blocking review issues remain", async () => {
    const { deps } = await testDeps();
    const id = await newCandidate(deps);
    const got = await sealCandidate(deps, id, "1.0.0", "op_017", PERMISSIVE);
    expect(got).toMatchObject({ ok: false, failure: "invalid" });
  });

  test("refuses a strict-loader failure the candidate stage's own check cannot see", async () => {
    const { deps } = await testDeps();
    const id = await newCandidate(deps);
    await resolveBasics(deps, id, "idempotent");
    const got = await sealCandidate(deps, id, "1.0.0", "op_017", NO_LOGIN_PATH);
    expect(got).toMatchObject({ ok: false, failure: "invalid" });
    expect(got.ok ? "" : (got.detail ?? "")).toContain("outside the effective allowlist");
  });

  test("refuses a version already sealed", async () => {
    const { deps } = await testDeps();
    const id = await newCandidate(deps);
    await resolveBasics(deps, id, "idempotent");
    const first = await sealCandidate(deps, id, "1.0.0", "op_017", PERMISSIVE);
    expect(first.ok).toBe(true);

    const id2 = await newCandidate(deps);
    await resolveBasics(deps, id2, "idempotent");
    const again = await sealCandidate(deps, id2, "1.0.0", "op_017", PERMISSIVE);
    expect(again).toMatchObject({ ok: false, failure: "conflict" });
  });

  test("refuses a smaller bump than the change needs; a large enough bump succeeds", async () => {
    const { deps } = await testDeps();
    const id = await newCandidate(deps);
    await resolveBasics(deps, id, "idempotent");
    // Seed a synthetic "previous" 1.0.0 with one more input than sign_in will ever have, so any
    // later seal of the real (input-free) contract counts as removing it: a major change.
    const runs = await deps.candidates.getFile(id, "runs.json");
    if (!runs.ok) throw new Error("test setup failed");
    const built = await regenerateCandidate(deps, id, runs.value);
    if (!built.ok) throw new Error("test setup failed");
    const previous: Artifact = {
      ...built.value.candidate,
      identity: { ...built.value.candidate.identity, version: "1.0.0" },
      provenance: { ...built.value.candidate.provenance, sealed: { by: "op_017", at: deps.clock.now().toISOString() } },
      contract: {
        ...built.value.candidate.contract,
        inputs: [
          { name: "member_id", type: "string", description: "A member number.", required: true, sensitivity: "none" },
        ],
      },
    };
    await deps.candidates.seal(id, "1.0.0", "op_017", previous, {});
    expect(neededBump(previous.contract, built.value.candidate.contract)).toBe("major");
    expect(proposeVersion({ version: "1.0.0", contract: previous.contract }, built.value.candidate.contract)).toBe(
      "2.0.0",
    );

    const id2 = await newCandidate(deps);
    await resolveBasics(deps, id2, "idempotent");
    const tooSmall = await sealCandidate(deps, id2, "1.0.1", "op_017", PERMISSIVE);
    expect(tooSmall).toMatchObject({ ok: false, failure: "invalid" });
    expect(tooSmall.ok ? "" : (tooSmall.detail ?? "")).toContain("major");

    const id3 = await newCandidate(deps);
    await resolveBasics(deps, id3, "idempotent");
    const bigEnough = await sealCandidate(deps, id3, "2.0.0", "op_017", PERMISSIVE);
    expect(bigEnough.ok).toBe(true);
  });

  test("writes artifact.json and one crop, leaves the run folder untouched, and no secret leaks", async () => {
    const { deps } = await testDeps();
    const evidence = deps.evidence as FakeEvidenceStore;
    const before = await evidence.events(TENANT, RUN_ID);
    const id = await newCandidate(deps);
    await resolveBasics(deps, id, "idempotent");
    const sealed = await sealCandidate(deps, id, "1.0.0", "op_017", PERMISSIVE);
    if (!sealed.ok) throw new Error(`seal failed: ${sealed.detail ?? sealed.failure}`);

    // The run folder is read-only to sealing.
    const after = await evidence.events(TENANT, RUN_ID);
    expect(after).toEqual(before);

    // The store wrote the sealed artifact and its one crop (the golden fixture's `click_login`
    // step's target, `login_button`, has a `crop` fingerprint, "crops/00009_e4.png").
    const store = deps.candidates as FakeCandidateStore<never, never>;
    const written = store.sealed("kvfcu/sign_in", "1.0.0");
    expect(written).not.toBeNull();
    expect(Object.keys(written?.crops ?? {})).toEqual(["login_button"]);
    expect(written?.index).toMatchObject([{ event: "sealed", kind: "artifact", id: "kvfcu/sign_in", rev: "1.0.0" }]);

    // The golden log's own `type` values are already masked references (section 4 §8): the
    // sealed bytes must keep them that way, never a raw value, everywhere `type` sends a value.
    const bytes = JSON.stringify(written?.artifact);
    for (const m of bytes.matchAll(/"type":"type","target":"[a-z_]+","value":"([^"]*)"/g)) {
      expect(m[1]).toMatch(/^\{secret\.[a-z_]+\}$/);
    }
    expect(bytes).toContain("{secret.operator_username}");
    expect(bytes).toContain("{secret.operator_password}");
  });

  test("copies a normal fixture's saved files byte for byte; a missing one is noted, never invented", async () => {
    const { deps } = await testDeps();
    const id = await newCandidate(deps);
    await resolveBasics(deps, id, "idempotent");
    const sealed = await sealCandidate(deps, id, "1.0.0", "op_017", PERMISSIVE);
    if (!sealed.ok) throw new Error(`seal failed: ${sealed.detail ?? sealed.failure}`);

    const fixture = sealed.value.normalFixtures.find((f) => f.fixture.location === "/login.do");
    if (fixture === undefined) throw new Error("expected a /login.do fixture");
    // The golden fixture's own turn 1 observation saved only an a11y snapshot (section 6 §14.5
    // fixture: tests/fixtures/logs/golden/), never a DOM or screenshot capture.
    expect(fixture.bytes["a11y.yaml"]).toEqual(
      new TextEncoder().encode(readFileSync(`${LOG_DIR}a11y/t1.yaml`, "utf8")),
    );
    expect([...fixture.missing].sort()).toEqual(["dom.html", "screen.png"]);
  });
});
