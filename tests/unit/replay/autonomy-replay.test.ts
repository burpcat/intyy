// Proves reconciliation autonomy through `runReplay` (design section 8 §14.2, section 5 §10.6;
// CLAUDE.md "only plain code may say nothing changed"): a granted record freezes
// `reconciliation_autonomy: true` for its own scope only (another check key, another jev version, no
// record, or a merely ready record freeze false); a granted run lets jev's sure `found` stand alone,
// with no reviewer call, except the 1-in-20 spot-check run; a spot check the reviewer answers with
// anything but `found` revokes (a history line by `system`, an `autonomy_revoked` alert, evidence zero)
// and the run goes to a human; a human who decides differently from jev's counted answer revokes; a
// human after jev's `unclear` does not; and SAFETY: jev's `not_found`, `unclear`, and any failure go to
// a human even when granted, and no model path ever sets the commit to absent or refused. Fake site,
// fake models, in-memory stores. M11 task 6.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { Alert } from "../../../src/core/model/alert.js";
import { Artifact as ArtifactSchema } from "../../../src/core/model/artifact.js";
import { Config } from "../../../src/core/model/config.js";
import type { JevReconcileOutput } from "../../../src/ports/models.js";
import { HistoryLine } from "../../../src/core/model/score-history.js";
import type { AutonomyCounts, AutonomyScope, ScoreKey } from "../../../src/core/model/score.js";
import { runReplay } from "../../../src/core/replay/executor.js";
import { spotChecked, type AutonomyLine } from "../../../src/core/trust/autonomy.js";
import { keyPath } from "../../../src/core/trust/keys.js";
import { rebuild } from "../../../src/core/trust/rebuild.js";
import { FakeAlertStore } from "../../../src/fakes/alert-store.js";
import { FakeOperator } from "../../../src/fakes/operator.js";
import type { FakeElement, FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { TableClassifier } from "../../../src/fakes/table-classifier.js";
import { TableReviewer } from "../../../src/fakes/table-reviewer.js";
import type { Row } from "../../../src/fakes/table.js";
import { HASHES } from "../trust/kit.js";
import { runId as runIdOf, world } from "../trust/live-kit.js";
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
const JEV = "jev@fake";
const CHECK_KEY = "kvfcu/check_strict@1.0.0";
const CAP = "kvfcu/open_strict@1";
const KEY: ScoreKey = { capability: "kvfcu/open_strict@1.0.0", tenant: TENANT, app_version: "8.4", patch_revision: null };
const SCOPE: AutonomyScope = { check: CHECK_KEY, check_patch: null, jev: JEV };

const LOGIN: FakeElement = { id: "login_button", role: "button", roleGroup: "button_like", name: "Login", text: "Login", onClick: { go: "/home" } };
const BOX: FakeElement = { id: "member_id_box", role: "textbox", roleGroup: "text_entry", label: "Member ID", field: { kind: "text", value: "" } };
const SEARCH: FakeElement = { id: "search_button", role: "button", roleGroup: "button_like", name: "Search", text: "Search", onClick: { go: "/result" } };
/** Confirm goes nowhere, so the commit is `uncertain` and the check child runs. */
const CONFIRM_STUCK: FakeElement = { id: "confirm_button", role: "button", roleGroup: "button_like", name: "Confirm", text: "Confirm" };
/** The check page shows the list but not the account cell: the child fails `target_not_found`, a check plain code cannot read. */
const SITE: FakeSite = {
  origin: ORIGIN,
  screens: {
    "/": { elements: [LOGIN] },
    "/home": { elements: [BOX, SEARCH] },
    "/result": { elements: [CONFIRM_STUCK, { id: "who", role: "generic", roleGroup: "container", text: `Member ${CANARY}` }] },
    "/done": { elements: [] },
    "/check": {
      elements: [
        { id: "list_marker", role: "generic", roleGroup: "container", text: "Accounts list" },
        { id: "row", role: "generic", roleGroup: "container", text: `Share Savings OPEN member ${CANARY}` },
      ],
    },
  },
};

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

// --- autonomy records ---------------------------------------------------------------------------------

const at = (minute: number): string => `2026-01-15T07:${String(minute).padStart(2, "0")}:00.000Z`;
const HALF: AutonomyCounts = { correct: 10, found: 5, not_found: 5, wrong: 0, unclear: 0 };
const earned = (minute: number, id: string, scope: AutonomyScope): AutonomyLine => ({
  event: "autonomy", at: at(minute), by: "certify", reason: id, action: "earned", evidence: [id], scope, counts: HALF,
});
const grant: AutonomyLine = { event: "autonomy", at: at(3), by: "op_022", reason: "Evidence is complete.", action: "granted", evidence: [] };

/** What the key's history holds before the run. `ready`: evidence only; `granted`: a grant on top; `none`: no autonomy line. */
type Held = { state: "none" | "ready" | "granted"; scope?: AutonomyScope };
function heldLines(h: Held): HistoryLine[] {
  const scope = h.scope ?? SCOPE;
  if (h.state === "none") return [];
  return [earned(1, "batch_a", scope), earned(2, "batch_b", scope), ...(h.state === "granted" ? [grant] : [])];
}

// --- models ---------------------------------------------------------------------------------------------

type Reply = Row<JevReconcileOutput>["reply"];
const answer = (verdict: JevReconcileOutput["verdict"], confidence: number): Reply => ({ answer: { verdict, confidence } });

/** A run ID the spot-check pick takes (or does not), found by the product's own function. */
function pickRunId(spot: boolean): string {
  for (let n = 1; n < 500; n += 1) if (spotChecked(runIdOf(n)) === spot) return runIdOf(n);
  throw new Error("test setup: no run ID found");
}
const SPOT = pickRunId(true);
const PLAIN = pickRunId(false);

type Opts = {
  held?: Held;
  jev?: Reply;
  reviewer?: Reply;
  /** Rebuilt records get this `jevVersion` on the models; `null` leaves it off. */
  jevVersion?: string | null;
  runId?: string;
  /** What the human decides if asked. */
  decision?: "found" | "not_found";
};

async function go(o: Opts = {}) {
  const w = world();
  const alerts = new FakeAlertStore<Alert>(Alert);
  const lines = heldLines(o.held ?? { state: "none" });
  for (const l of lines) if (!(await w.scores.append(keyPath(KEY), l)).ok) throw new Error("test setup: append failed");
  if (lines.length > 0) {
    const rec = rebuild(KEY, HASHES, lines);
    if (!rec.ok || !(await w.scores.putRecord(keyPath(KEY), rec.value)).ok) throw new Error("test setup: putRecord failed");
  }
  const classifier = new TableClassifier({ reconcile: [{ when: {}, reply: o.jev ?? answer("found", 0.95) }] });
  const reviewer = new TableReviewer({ secondOpinion: [{ when: {}, reply: o.reviewer ?? answer("found", 0.95) }] });
  const operator = new FakeOperator([
    { staff: "op_017", decision: "approved" },
    { staff: "op_017", decision: o.decision ?? "found" },
    { staff: "op_017", decision: "no_retry" },
  ]);
  const jevVersion = o.jevVersion === undefined ? JEV : o.jevVersion;
  const h = await buildHarness(SITE, {
    operator: () => operator,
    models: { classifier, reviewer, ...(jevVersion === null ? {} : { jevVersion }) },
    scores: w.scores,
    locks: w.locks,
    alerts,
  });
  for (const [name, art, n] of [["check_strict", CHECK_STRICT, "1000000011"], ["open_strict", OPEN_STRICT, "1000000012"]] as const) {
    const sealed = await h.deps.artifacts.seal(`kvfcu/${name}/cand_2026-01-15_${n}`, "1.0.0", "op_017", art, {});
    if (!sealed.ok) throw new Error(`test setup: ${name} seal failed`);
  }
  const base = replayInputOf(h, requestOf({ authorization: authorizationFor(CAP), capability: CAP, inputs: { member_id: CANARY } }), o.runId === undefined ? {} : { runId: o.runId });
  const { runId, result } = await runReplay(base, h.deps);
  const events = await h.deps.evidence.events(TENANT, runId);
  if (!events.ok) throw new Error("events missing");
  const history = await w.scores.history(keyPath(KEY));
  if (!history.ok) throw new Error("history unreadable");
  const listed = await alerts.list();
  if (!listed.ok) throw new Error("alerts unreadable");
  const start = (events.value as { event: string; data: { frozen?: { ladder?: Record<string, unknown> } } }[]).find((e) => e.event === "run_start");
  return {
    runId,
    result,
    classifier,
    reviewer,
    operator,
    ladder: start?.data.frozen?.ladder,
    history: history.value,
    revocations: history.value.filter((l) => l.event === "autonomy" && l.action === "revoked"),
    alerts: listed.value.filter((a) => a.pattern === "autonomy_revoked"),
    asked: operator.requests.map((r) => r.kind).includes("reconciliation_decision"),
  };
}

describe("the frozen reconciliation_autonomy fact", () => {
  test("a granted record for the run's own scope freezes true", async () => {
    expect((await go({ held: { state: "granted" } })).ladder).toMatchObject({ jev: true, reconciliation_autonomy: true });
  });

  test("no record, or a merely ready record, freezes false", async () => {
    for (const held of [{ state: "none" }, { state: "ready" }] as const) {
      expect((await go({ held })).ladder).toMatchObject({ reconciliation_autonomy: false });
    }
  });

  test("a granted record for another check key freezes false", async () => {
    const held: Held = { state: "granted", scope: { ...SCOPE, check: "kvfcu/other_check@1.0.0" } };
    expect((await go({ held })).ladder).toMatchObject({ reconciliation_autonomy: false });
  });

  test("another jev version, or no jev version wired, freezes false", async () => {
    expect((await go({ held: { state: "granted" }, jevVersion: "jev@next" })).ladder).toMatchObject({ reconciliation_autonomy: false });
    expect((await go({ held: { state: "granted" }, jevVersion: null })).ladder).toMatchObject({ reconciliation_autonomy: false });
  });
});

describe("a granted run (section 5 §10.6)", () => {
  test("jev found, a non-spot run: jev decides alone, the reviewer is never asked, no human is asked, nothing is revoked", async () => {
    const r = await go({ held: { state: "granted" }, runId: PLAIN });
    expect(r.result.effect).toMatchObject({ commit: "found_by_check", check: { decided_by: "jev", staff_id: null } });
    expect(r.classifier.seen.map((s) => s.kind)).toEqual(["reconcile"]);
    expect(r.reviewer.seen).toEqual([]);
    expect(r.asked).toBe(false);
    expect(r.revocations).toEqual([]);
    expect(r.alerts).toEqual([]);
  });

  test("the same run without a grant asks the reviewer too (the second opinion before autonomy)", async () => {
    const r = await go({ held: { state: "ready" }, runId: PLAIN });
    expect(r.reviewer.seen).toHaveLength(1);
    expect(r.result.effect).toMatchObject({ check: { decided_by: "jev" } });
  });

  test("a spot-check run asks the reviewer; agreeing, jev still decides and nothing is revoked", async () => {
    const r = await go({ held: { state: "granted" }, runId: SPOT });
    expect(r.reviewer.seen).toHaveLength(1);
    expect(r.result.effect).toMatchObject({ check: { decided_by: "jev" } });
    expect(r.asked).toBe(false);
    expect(r.revocations).toEqual([]);
  });

  test.each([
    ["not_found", answer("not_found", 0.99)],
    ["unclear", answer("unclear", 0.99)],
  ])("a spot check where the reviewer says %s: revoked by system, evidence zero, an alert, and the run goes to a human", async (_n, reviewer) => {
    const r = await go({ held: { state: "granted" }, runId: SPOT, reviewer });
    expect(r.asked).toBe(true);
    expect(r.result.effect).toMatchObject({ commit: "found_by_check", check: { decided_by: "human" } });
    expect(r.revocations).toHaveLength(1);
    expect(r.revocations[0]).toMatchObject({ by: "system", action: "revoked" });
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatchObject({ tenant: TENANT, evidence_runs: [SPOT] });
    expect(r.alerts[0]?.keys).toEqual(["kvfcu/open_strict@1.0.0"]);
    // The record is revoked with zero evidence: a later run freezes false.
    const record = rebuild(KEY, HASHES, r.history);
    expect(record.ok && record.value.autonomy).toMatchObject({ state: "revoked", evidence: { correct: 0, found: 0, not_found: 0, batches: [] } });
  });

  test("a reviewer that gives no usable answer on a spot check is not a disagreement", async () => {
    const r = await go({ held: { state: "granted" }, runId: SPOT, reviewer: { failure: "timeout" } });
    expect(r.revocations).toEqual([]);
    expect(r.alerts).toEqual([]);
    expect(r.result.effect).toMatchObject({ check: { decided_by: "jev" } });
  });
});

describe("a human who decides differently from jev (section 8 §14.2)", () => {
  test("jev found, the reviewer disagrees, the human says not_found: autonomy is revoked, once", async () => {
    const r = await go({ held: { state: "ready" }, reviewer: answer("not_found", 0.99), decision: "not_found" });
    expect(r.asked).toBe(true);
    expect(r.revocations).toHaveLength(1);
    expect(r.revocations[0]).toMatchObject({ by: "system" });
    expect(r.alerts).toHaveLength(1);
  });

  test("jev found, the reviewer disagrees, the human agrees with jev: a ready record is not revoked", async () => {
    const r = await go({ held: { state: "ready" }, reviewer: answer("not_found", 0.99), decision: "found" });
    expect(r.asked).toBe(true);
    expect(r.revocations).toEqual([]);
    expect(r.alerts).toEqual([]);
  });

  test("jev not_found, the human says found: revoked", async () => {
    const r = await go({ held: { state: "ready" }, jev: answer("not_found", 0.99), decision: "found" });
    expect(r.asked).toBe(true);
    expect(r.revocations).toHaveLength(1);
    expect(r.alerts).toHaveLength(1);
  });

  test("after jev's unclear, a human answer revokes nothing: there was no counted answer to differ from", async () => {
    for (const decision of ["found", "not_found"] as const) {
      const r = await go({ held: { state: "granted" }, jev: answer("unclear", 0.99), decision });
      expect(r.asked).toBe(true);
      expect(r.revocations).toEqual([]);
      expect(r.alerts).toEqual([]);
    }
  });

  test("a jev with no usable answer (timeout) leaves nothing to differ from either", async () => {
    const r = await go({ held: { state: "granted" }, jev: { failure: "timeout" }, decision: "not_found" });
    expect(r.asked).toBe(true);
    expect(r.revocations).toEqual([]);
  });

  test("a run with another check key or jev version cannot revoke the held autonomy", async () => {
    const other: Held = { state: "granted", scope: { ...SCOPE, check: "kvfcu/other_check@1.0.0" } };
    const r = await go({ held: other, jev: answer("not_found", 0.99), decision: "found" });
    expect(r.asked).toBe(true);
    expect(r.revocations).toEqual([]);
    const v = await go({ held: { state: "granted" }, jevVersion: "jev@next", jev: answer("not_found", 0.99), decision: "found" });
    expect(v.revocations).toEqual([]);
  });

  test("no autonomy record at all: nothing is written", async () => {
    const r = await go({ held: { state: "none" }, jev: answer("not_found", 0.99), decision: "found" });
    expect(r.history.filter((l) => l.event === "autonomy")).toEqual([]);
    expect(r.alerts).toEqual([]);
  });
});

describe("SAFETY: only plain code says nothing changed", () => {
  const jevAnswers: [string, Reply][] = [
    ["found 0.95", answer("found", 0.95)],
    ["found 0.85", answer("found", 0.85)],
    ["not_found 0.99", answer("not_found", 0.99)],
    ["unclear 0.99", answer("unclear", 0.99)],
    ["timeout", { failure: "timeout" }],
    ["bad output", { raw: { verdict: "maybe" } }],
  ];
  const reviewers: Reply[] = [answer("found", 0.95), answer("not_found", 0.99), answer("unclear", 0.99), { failure: "timeout" }];

  test("granted, spot or not: jev's not_found, unclear, a low found, and any failure always go to a human", async () => {
    for (const runId of [PLAIN, SPOT]) {
      for (const [name, jev] of jevAnswers.slice(1)) {
        const r = await go({ held: { state: "granted" }, runId, jev, decision: "found" });
        expect(r.asked, `${name} on ${runId}`).toBe(true);
        expect(r.result.effect, name).toMatchObject({ commit: "found_by_check", check: { decided_by: "human" } });
        expect(r.reviewer.seen, name).toEqual([]);
      }
    }
  });

  test("granted: across every jev and reviewer answer, spot or not, no model sets absent_by_check or refused", async () => {
    for (const runId of [PLAIN, SPOT])
      for (const [name, jev] of jevAnswers)
        for (const reviewer of reviewers) {
          const r = await go({ held: { state: "granted" }, runId, jev, reviewer, decision: "found" });
          const effect = r.result.effect;
          expect(effect?.commit, name).toBe("found_by_check");
          expect(JSON.stringify(effect), name).not.toMatch(/absent_by_check|refused/);
          expect(r.operator.requests.map((q) => q.kind).includes("retry_decision"), name).toBe(false);
          // A model decides alone only on a sure jev `found`; any other end is a human's.
          if (effect?.check?.decided_by === "jev") expect(name).toBe("found 0.95");
        }
  }, 120_000);

  test("a human's not_found is the only way a check ends absent, even when jev said not_found and autonomy is granted", async () => {
    const r = await go({ held: { state: "granted" }, jev: answer("not_found", 0.99), decision: "not_found" });
    expect(r.asked).toBe(true);
    expect(r.result.effect).toMatchObject({ commit: "absent_by_check", check: { decided_by: "human", staff_id: "op_017" } });
  });
});
