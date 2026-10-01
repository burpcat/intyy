// Proves reconciliation with models through `runReplay`: a check child that fails in a way plain
// code cannot read goes to jev, then to the reviewer's second opinion. Only two sure `found`
// answers settle it (failed, outputs_unavailable, commit found_by_check, decided_by jev). Every
// other case opens a human `reconciliation_decision`. A model never sets absent_by_check or
// refused. Plain-code answers never call a model. Design section 5 §10.5 to §10.7, section 7 §11.1;
// CLAUDE.md. M09 task 6.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { Artifact as ArtifactSchema } from "../../../src/core/model/artifact.js";
import { Config } from "../../../src/core/model/config.js";
import { runReplay } from "../../../src/core/replay/executor.js";
import type { MergeResult } from "../../../src/core/safety/policy/merge.js";
import { FakeOperator } from "../../../src/fakes/operator.js";
import type { FakeElement, FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { TableClassifier } from "../../../src/fakes/table-classifier.js";
import { TableReviewer } from "../../../src/fakes/table-reviewer.js";
import type { Row } from "../../../src/fakes/table.js";
import type { JevReconcileOutput } from "../../../src/ports/models.js";
import {
  CHECK_SUB,
  ORIGIN,
  OPEN_SUB_CHECKED,
  TENANT,
  authorizationFor,
  buildHarness,
  replayInputOf,
  requestOf,
} from "./executor-harness.js";

const CANARY = Config.parse(JSON.parse(readFileSync("intyy.json", "utf8"))).canary_members[0] ?? "";

const LOGIN: FakeElement = { id: "login_button", role: "button", roleGroup: "button_like", name: "Login", text: "Login", onClick: { go: "/home" } };
const BOX: FakeElement = { id: "member_id_box", role: "textbox", roleGroup: "text_entry", label: "Member ID", field: { kind: "text", value: "" } };
const SEARCH: FakeElement = { id: "search_button", role: "button", roleGroup: "button_like", name: "Search", text: "Search", onClick: { go: "/result" } };
/** Confirm goes nowhere, so the commit is `uncertain` and the check child runs. */
const CONFIRM_STUCK: FakeElement = { id: "confirm_button", role: "button", roleGroup: "button_like", name: "Confirm", text: "Confirm" };
const ACCOUNT: FakeElement = { id: "account_number_display", role: "generic", roleGroup: "container", label: "Account number", text: "SH9999999" };
const marker = (text: string): FakeElement => ({ id: "list_marker", role: "generic", roleGroup: "container", text });

/** The check page. `unreadable`: the list shows, but the account cell is missing, so the child's
 * read fails with `target_not_found` and no declared outcome: "anything else" (section 7 §11.1). */
function site(check: "unreadable" | "found" | "absent"): FakeSite {
  const checkElements: FakeElement[] =
    check === "unreadable"
      ? [marker("Accounts list"), { id: "row", role: "generic", roleGroup: "container", text: `Share Savings OPEN member ${CANARY}` }]
      : check === "found"
        ? [marker("Accounts list"), ACCOUNT]
        : [marker("Accounts list"), ACCOUNT, { id: "not_found_msg", role: "generic", roleGroup: "container", text: "No sub-account found" }];
  return {
    origin: ORIGIN,
    screens: {
      "/": { elements: [LOGIN] },
      "/home": { elements: [BOX, SEARCH] },
      "/result": { elements: [CONFIRM_STUCK, { id: "who", role: "generic", roleGroup: "container", text: `Member ${CANARY}` }] },
      "/done": { elements: [] },
      "/check": { elements: checkElements },
    },
  };
}

/** `check_sub` with a text precondition, so a missing target ends the child `failed` instead of
 * climbing (docs/decisions.md, M06's carve-out): a check plain code cannot read. */
const CHECK_STRICT = ArtifactSchema.parse({
  ...CHECK_SUB,
  identity: { ...CHECK_SUB.identity, capability: "check_strict" },
  conditions: [
    ...CHECK_SUB.conditions,
    { id: "list_shown", check: "text_visible", description: "The list shows", text: "Accounts list", match: "contains" },
  ],
  steps: CHECK_SUB.steps.map((s) => ({ ...s, precondition: "list_shown", checkpoint: "list_shown" })),
});
const OPEN_STRICT = ArtifactSchema.parse({
  ...OPEN_SUB_CHECKED,
  identity: { ...OPEN_SUB_CHECKED.identity, capability: "open_strict" },
  recovery: {
    commit_point: "click_confirm",
    reconciliation: {
      check: {
        capability: "kvfcu/check_strict@1",
        inputs: { member_id: "{input.member_id}" },
        not_found_outcomes: ["sub_not_found"],
        outputs: { account_number: "{result.account_number}" },
      },
    },
  },
});
const CAP = "kvfcu/open_strict@1";

type Harness = Awaited<ReturnType<typeof buildHarness>>;

const say = (verdict: JevReconcileOutput["verdict"], confidence: number): Row<JevReconcileOutput> => ({
  when: {},
  reply: { answer: { verdict, confidence } },
});

type Models = { classifier?: TableClassifier; reviewer?: TableReviewer; off?: boolean };

/** Runs the strict capability against `check`'s page. The operator answers the start
 * confirmation, then (when asked) `decision`. */
async function go(
  check: "unreadable" | "found" | "absent",
  models: Models | undefined,
  opts: { decision?: string; policy?: Partial<MergeResult["effective"]["llm"]> } = {},
) {
  const operator = new FakeOperator([
    { staff: "op_017", decision: "approved" },
    { staff: "op_017", decision: opts.decision ?? "found" },
    { staff: "op_017", decision: "no_retry" },
  ]);
  const h = await buildHarness(site(check), {
    operator: () => operator,
    ...(models === undefined ? {} : { models }),
  });
  for (const [name, art, n] of [["check_strict", CHECK_STRICT, "1000000011"], ["open_strict", OPEN_STRICT, "1000000012"]] as const) {
    const sealed = await h.deps.artifacts.seal(`kvfcu/${name}/cand_2026-01-15_${n}`, "1.0.0", "op_017", art, {});
    if (!sealed.ok) throw new Error(`test setup: ${name} seal failed`);
  }
  const base = replayInputOf(h, requestOf({ authorization: authorizationFor(CAP), capability: CAP, inputs: { member_id: CANARY } }));
  const input = opts.policy === undefined ? base : { ...base, policy: { ...h.policy, effective: { ...h.policy.effective, llm: { ...h.policy.effective.llm, ...opts.policy } } } };
  const { runId, result } = await runReplay(input, h.deps);
  return { h, runId, result, operator };
}

/** Both models answer for a reconciliation, and nothing else. Child trouble calls never happen
 * (the check is built so the child fails hard); an unscripted call would throw. */
const models = (jev: Row<JevReconcileOutput>, rev: Row<JevReconcileOutput>): Models => ({
  classifier: new TableClassifier({ reconcile: [jev] }),
  reviewer: new TableReviewer({ secondOpinion: [rev] }),
});

async function eventsOf(h: Harness, runId: string) {
  const e = await h.deps.evidence.events(TENANT, runId);
  if (!e.ok) throw new Error("events missing");
  return e.value as { event: string; by?: string; step: string | null; data: Record<string, unknown> }[];
}

async function llmFiles(h: Harness, runId: string): Promise<string[]> {
  const json = await h.deps.evidence.readRunJson(TENANT, runId);
  if (!json.ok) throw new Error("no run.json");
  return (json.value as { files: { path: string }[] }).files.map((f) => f.path).filter((f) => f.startsWith("llm/"));
}

async function readText(h: Harness, runId: string, path: string): Promise<string> {
  const folder = await h.deps.evidence.openRun(TENANT, runId);
  if (!folder.ok) throw new Error("no run folder");
  const got = await folder.value.readFile(path);
  if (!got.ok) throw new Error(`no file ${path}`);
  return new TextDecoder().decode(got.value);
}

/** The effect names the real check child (kind reconciliation, parent `runId`), decided by a human. */
async function expectHumanOnChild(h: Harness, runId: string, effect: { commit: string; check?: { run_id: string; decided_by: string } | undefined } | null | undefined) {
  expect(effect).toMatchObject({ commit: "found_by_check", check: { decided_by: "human" } });
  const childRunId = effect?.check?.run_id;
  if (typeof childRunId !== "string") throw new Error("no child run id recorded");
  const child = await h.deps.evidence.readRunJson(TENANT, childRunId);
  if (!child.ok) throw new Error("child run.json missing");
  expect(child.value).toMatchObject({ kind: "reconciliation", parent_run_id: runId });
}

const requestKinds = (op: FakeOperator) => op.requests.map((r) => r.kind);

describe("both models sure and agreeing (section 5 §10.6)", () => {
  test("found: failed outputs_unavailable, commit found_by_check, decided_by jev, and no human is asked", async () => {
    const m = models(say("found", 0.95), say("found", 0.95));
    const { result, operator } = await go("unreadable", m);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failure.code).toBe("outputs_unavailable");
    expect(result.effect).toMatchObject({ commit: "found_by_check", check: { decided_by: "jev", staff_id: null } });
    expect(m.classifier?.seen.map((s) => s.kind)).toEqual(["reconcile"]);
    expect(m.reviewer?.seen.map((s) => s.kind)).toEqual(["secondOpinion"]);
    expect(requestKinds(operator)).toEqual(["start_confirmation"]);
  });

  test("the model input holds the check's failure and the parent's last screen, never the canary", async () => {
    const m = models(say("found", 0.95), say("found", 0.95));
    const { h, runId } = await go("unreadable", m);

    const input = m.classifier?.seen[0]?.input as unknown as { parent: { commit_step: { id: string }; last_screen: { location: string } }; check: { status: string; failure: { code: string } | null; capability: string }; not_found_outcomes: readonly string[] };
    expect(input.parent.commit_step.id).toBe("click_confirm");
    expect(input.parent.last_screen.location).toBe("/result");
    expect(input.check).toMatchObject({ capability: "kvfcu/check_strict@1", status: "failed" });
    expect(input.check.failure?.code).toBe("target_not_found");
    expect(input.not_found_outcomes).toEqual(["sub_not_found"]);
    expect(m.reviewer?.seen[0]?.input).toEqual(m.classifier?.seen[0]?.input);
    // The parent's screen does show the member ID, so the check below is not vacuous.
    expect(JSON.stringify(input)).toContain("{input.member_id}");
    expect(JSON.stringify(input)).not.toContain(CANARY);

    for (const f of await llmFiles(h, runId)) expect(await readText(h, runId, f)).not.toContain(CANARY);
  });
});

describe("a human decides everything else (section 5 §10.6)", () => {
  test("jev found, reviewer not_found: disagreement opens a reconciliation_decision, and the human's answer stands", async () => {
    const m = models(say("found", 0.95), say("not_found", 0.99));
    const { h, runId, result, operator } = await go("unreadable", m, { decision: "found" });
    expect(requestKinds(operator).slice(0, 2)).toEqual(["start_confirmation", "reconciliation_decision"]);
    expect(m.reviewer?.seen).toHaveLength(1);
    await expectHumanOnChild(h, runId, result.effect);
  });

  test("no models at all: plain code's unclear check goes to a human, and the child run id is kept", async () => {
    const { h, runId, result, operator } = await go("unreadable", undefined, { decision: "found" });
    expect(requestKinds(operator)[1]).toBe("reconciliation_decision");
    await expectHumanOnChild(h, runId, result.effect);
  });

  test("jev found 0.85: a human is asked, and the reviewer is never called", async () => {
    const m = models(say("found", 0.85), say("found", 0.99));
    const { operator } = await go("unreadable", m);
    expect(requestKinds(operator)[1]).toBe("reconciliation_decision");
    expect(m.reviewer?.seen).toEqual([]);
  });

  test("jev not_found 0.99: a human is asked; the commit is never absent_by_check from a model", async () => {
    const m = models(say("not_found", 0.99), say("not_found", 0.99));
    const { h, runId, result, operator } = await go("unreadable", m, { decision: "found" });
    expect(requestKinds(operator)[1]).toBe("reconciliation_decision");
    expect(m.reviewer?.seen).toEqual([]);
    expect(result.effect).not.toMatchObject({ commit: "absent_by_check" });
    await expectHumanOnChild(h, runId, result.effect);
  });

  test("--models off: a human is asked and no model is called", async () => {
    const m = { ...models(say("found", 1), say("found", 1)), off: true };
    const { operator } = await go("unreadable", m);
    expect(requestKinds(operator)[1]).toBe("reconciliation_decision");
    expect(m.classifier?.seen).toEqual([]);
    expect(m.reviewer?.seen).toEqual([]);
  });

  test("replay_jev off: a human is asked and no model is called", async () => {
    const m = models(say("found", 1), say("found", 1));
    const { operator } = await go("unreadable", m, { policy: { replay_jev: false } });
    expect(requestKinds(operator)[1]).toBe("reconciliation_decision");
    expect(m.classifier?.seen).toEqual([]);
    expect(m.reviewer?.seen).toEqual([]);
  });

  test("no classifier port: a human is asked even when a reviewer is wired", async () => {
    const reviewer = new TableReviewer({ secondOpinion: [say("found", 1)] });
    const { operator } = await go("unreadable", { reviewer });
    expect(requestKinds(operator)[1]).toBe("reconciliation_decision");
    expect(reviewer.seen).toEqual([]);
  });

  test("replay_reviewer off: jev found alone cannot settle; a human is asked", async () => {
    const m = models(say("found", 1), say("found", 1));
    const { operator } = await go("unreadable", m, { policy: { replay_reviewer: false } });
    expect(requestKinds(operator)[1]).toBe("reconciliation_decision");
    expect(m.reviewer?.seen).toEqual([]);
  });

  test("a jev timeout and a jev bad answer each go to a human, with a warning line", async () => {
    for (const [reply, code] of [
      [{ failure: "timeout" }, "classifier_unavailable"],
      [{ raw: { verdict: "maybe" } }, "classifier_invalid_output"],
    ] as const) {
      const m: Models = {
        classifier: new TableClassifier({ reconcile: [{ when: {}, reply }] }),
        reviewer: new TableReviewer({ secondOpinion: [say("found", 1)] }),
      };
      const { h, runId, operator } = await go("unreadable", m);
      expect(requestKinds(operator)[1]).toBe("reconciliation_decision");
      expect((await eventsOf(h, runId)).filter((e) => e.event === "warning").map((e) => e.data.code)).toContain(code);
    }
  });
});

describe("plain code first (section 7 §11.1)", () => {
  test("a found check never calls a model", async () => {
    const m = models(say("found", 1), say("found", 1));
    const { result } = await go("found", m);
    expect(result.status).toBe("success");
    expect(result.effect).toMatchObject({ commit: "found_by_check", check: { decided_by: "code" } });
    expect(m.classifier?.seen).toEqual([]);
    expect(m.reviewer?.seen).toEqual([]);
  });

  test("a listed not-found outcome is absent_by_check from plain code, with no model call", async () => {
    const m = models(say("found", 1), say("found", 1));
    const { result } = await go("absent", m, { decision: "no_retry" });
    expect(result.effect).toMatchObject({ commit: "absent_by_check", check: { decided_by: "code" } });
    expect(m.classifier?.seen).toEqual([]);
    expect(m.reviewer?.seen).toEqual([]);
  });
});

describe("safety: a model never sets absent_by_check or refused", () => {
  const verdicts = ["found", "not_found", "unclear"] as const;
  const confidences = [0, 0.89, 0.95, 1];
  const failures = [
    { failure: "timeout" },
    { failure: "unavailable" },
    { failure: "refused" },
    { raw: { nonsense: true } },
  ] as const;

  test("across every jev and reviewer answer, a model-only end is found_by_check; any other end is a human's", async () => {
    const answers: Row<JevReconcileOutput>["reply"][] = [
      ...verdicts.flatMap((v) => confidences.map((c) => ({ answer: { verdict: v, confidence: c } }))),
      ...failures,
    ];
    for (const a of answers)
      for (const b of answers) {
        const m: Models = {
          classifier: new TableClassifier({ reconcile: [{ when: {}, reply: a }] }),
          reviewer: new TableReviewer({ secondOpinion: [{ when: {}, reply: b }] }),
        };
        const { result, operator } = await go("unreadable", m, { decision: "found" });
        const asked = requestKinds(operator).includes("reconciliation_decision");
        const effect = result.effect;
        expect(effect?.commit).toBe("found_by_check");
        expect(JSON.stringify(effect)).not.toMatch(/absent_by_check|refused/);
        // A model decides alone only when both said a sure found; else a person decided.
        expect(effect?.check?.decided_by).toBe(asked ? "human" : "jev");
        expect(requestKinds(operator).includes("retry_decision")).toBe(false);
      }
  }, 60_000);
});

describe("order and logging (section 9 §5.3; section 3 §6.4)", () => {
  test("request is written before reply, for jev then reviewer, and the lines name the request files", async () => {
    const m = models(say("found", 0.95), say("found", 0.95));
    const { h, runId } = await go("unreadable", m);

    const files = await llmFiles(h, runId);
    expect(files).toEqual([
      expect.stringMatching(/^llm\/\d{5}_jev_request\.json$/),
      expect.stringMatching(/^llm\/\d{5}_jev_reply\.json$/),
      expect.stringMatching(/^llm\/\d{5}_reviewer_request\.json$/),
      expect.stringMatching(/^llm\/\d{5}_reviewer_reply\.json$/),
    ]);

    const lines = (await eventsOf(h, runId)).filter((e) => e.event === "reconciliation");
    expect(lines.map((l) => l.by)).toEqual(["jev", "reviewer"]);
    expect(lines[0]).toMatchObject({ step: "click_confirm", data: { verdict: "found", confidence: 0.95, threshold: 0.9 } });
    // The path is intyy's own, shown plain: the digit rule must not mask it.
    expect(lines[0]?.data.input).toBe(files[0]);
    expect(lines[1]?.data.input).toBe(files[2]);
    expect(await readText(h, runId, files[0] ?? "")).toBe(JSON.stringify(m.classifier?.seen[0]?.input));
    expect(await readText(h, runId, files[2] ?? "")).toBe(JSON.stringify(m.reviewer?.seen[0]?.input));
  });

  test("when jev is not sure, only the jev files exist", async () => {
    const m = models(say("unclear", 0.5), say("found", 1));
    const { h, runId } = await go("unreadable", m);
    expect(await llmFiles(h, runId)).toEqual([
      expect.stringMatching(/^llm\/\d{5}_jev_request\.json$/),
      expect.stringMatching(/^llm\/\d{5}_jev_reply\.json$/),
    ]);
    expect((await eventsOf(h, runId)).filter((e) => e.event === "reconciliation").map((e) => e.by)).toEqual(["jev"]);
  });

  test("no raw canary reaches the llm/ files or the log", async () => {
    const m = models(say("found", 0.95), say("found", 0.95));
    const { h, runId } = await go("unreadable", m);
    for (const f of await llmFiles(h, runId)) expect(await readText(h, runId, f)).not.toContain(CANARY);
    expect(JSON.stringify(await eventsOf(h, runId))).not.toContain(CANARY);
  });
});
