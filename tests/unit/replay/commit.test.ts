// Proves the commit path (design section 4 §7.8, the four replay checks; section 3 §6.6,
// write-ahead; section 3 §5.8, the effect block; section 2 §16.6, commit states): a failed
// durable write means the action is never sent; the live re-check blocks a stricter or
// word-less control; the commit state follows what happened on screen; a missing
// authorization pauses for a human answer. M05 task 7.
import { describe, expect, test } from "vitest";
import {
  commitStep,
  type CommitApproval,
  type CommitContext,
} from "../../../src/core/replay/commit.js";
import type { Condition } from "../../../src/core/model/artifact/conditions.js";
import type { ContractOutcome } from "../../../src/core/model/artifact/contract.js";
import type { RiskKind, Step } from "../../../src/core/model/artifact/steps.js";
import type { Target } from "../../../src/core/model/artifact/targets.js";
import { redactionRules, Redactor } from "../../../src/core/safety/redaction/redactor.js";
import {
  openGate,
  type Gate,
  type GateDeps,
  type GateLine,
  type GateRun,
} from "../../../src/core/safety/gate/gate.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import type { FakeElement, FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { snapshotFactory } from "../../../src/fakes/snapshot-surface/index.js";
import type { Clock } from "../../../src/ports/clock.js";
import { fail, ok } from "../../../src/ports/outcome.js";
import type { Eyes, Observation } from "../../../src/ports/surface.js";
import { LEASE, gateConfig, testPolicy, testSecrets } from "../../contract/surface/gate-kit.js";

const ORIGIN = "http://127.0.0.1:9195";

/** One small policy: the commit page, and the two screens a click may land on. */
const policy = testPolicy({
  allow: ["/", "/confirmed", "/refused"],
  deny: [],
  irreversible: [],
});

/** An authorized replay run: check 1's authorization is present and valid. */
const AUTHORIZED: GateRun = {
  kind: "replay",
  readOnly: false,
  forceHuman: false,
  authorizationValid: () => true,
  declaredPaths: null,
};

/** An unattended replay run with no valid authorization: the commit pauses for approval. */
const UNAUTHORIZED: GateRun = {
  kind: "replay",
  readOnly: false,
  forceHuman: false,
  authorizationValid: () => false,
  declaredPaths: null,
};

/** The commit target, and the checkpoint it never reaches, for a live-re-check test that
 * must never actually dispatch. */
const CP_NEVER: Condition = {
  id: "cp_never",
  description: "Never true.",
  check: "location",
  pattern: "/never-reached",
};
const CP_CONFIRMED: Condition = {
  id: "cp_confirmed",
  description: "The confirmed page shows.",
  check: "location",
  pattern: "/confirmed",
};
const CP_REFUSED: Condition = {
  id: "cnd_refused",
  description: "The refused page shows.",
  check: "location",
  pattern: "/refused",
};
const CONDITIONS = new Map(
  [CP_NEVER, CP_CONFIRMED, CP_REFUSED].map((c): [string, Condition] => [c.id, c]),
);
const DECLINED_OUTCOME: ContractOutcome = {
  code: "declined",
  description: "The bank declined the change.",
  condition: "cnd_refused",
};

/** A site with one commit control on `/`, and the two pages a click may land on. */
function siteWith(button: FakeElement): FakeSite {
  return {
    origin: ORIGIN,
    screens: {
      "/": { elements: [button] },
      "/confirmed": { elements: [] },
      "/refused": { elements: [] },
    },
  };
}

/** An artifact target: an ID and a made-up description, with the given clues. */
function target(id: string, clues: Target["clues"]): Target {
  return { id, description: id, clues };
}

/** A one-click commit step. `checkpoint` and `outcomes` name entries in {@link CONDITIONS}. */
function commitStepDef(opts: {
  targetId: string;
  risk: RiskKind;
  checkpoint: string;
  outcomes?: string[];
  timeoutMs?: number;
}): Step {
  return {
    id: "commit",
    intent: "Commit the change.",
    action: { type: "click", target: opts.targetId },
    precondition: "n_a",
    checkpoint: opts.checkpoint,
    outcomes: opts.outcomes ?? [],
    risk: opts.risk,
    timeout_ms: opts.timeoutMs ?? 1_000,
  };
}

/** A fake approval that always answers the same way. */
function approvalOf(
  answer: Awaited<ReturnType<CommitApproval["ask"]>>,
): CommitApproval {
  return { ask: () => Promise.resolve(answer) };
}

/** Opens a gate over `site`, with `extra` overriding any `GateDeps` field (like `beforeDispatch`). */
async function openCommitGate(
  site: FakeSite,
  run: GateRun,
  extra: Partial<GateDeps> = {},
): Promise<{ eyes: Eyes; gate: Gate; lines: GateLine[]; redactor: Redactor }> {
  const lines: GateLine[] = [];
  const redactor = new Redactor(redactionRules(policy));
  const deps: GateDeps = {
    policy,
    redactor,
    run,
    lease: () => LEASE,
    log: (l) => lines.push(l),
    secrets: testSecrets(policy),
    ...extra,
  };
  const opened = await openGate(snapshotFactory(site), gateConfig(ORIGIN, policy), deps);
  if (!opened.ok) throw new Error(`open failed: ${opened.failure}`);
  return { eyes: opened.value.eyes, gate: opened.value.gate, lines, redactor };
}

/** Observes, or fails the test. */
async function look(eyes: Eyes): Promise<Observation> {
  const o = await eyes.observe();
  if (!o.ok) throw new Error(`observe failed: ${o.failure}`);
  return o.value;
}

/** A `CommitContext` over one opened gate and one target, at `observation`. */
function commitCtx(
  opened: { eyes: Eyes; gate: Gate; redactor: Redactor },
  observation: Observation,
  t: Target,
  approval: CommitApproval,
  clock: Clock = new SteppingClock(),
): CommitContext {
  return {
    observation,
    eyes: opened.eyes,
    targets: new Map([[t.id, t]]),
    conditions: CONDITIONS,
    outputs: new Map(),
    refs: undefined,
    redactor: opened.redactor,
    gate: opened.gate,
    lease: LEASE,
    clock,
    approval,
    screenshot: null,
  };
}

const NEVER_APPROVAL = approvalOf({ kind: "declined" });

describe("commitStep: write-ahead (section 3 §6.6)", () => {
  test("a failed durable write means the action is never sent", async () => {
    const site = siteWith({
      id: "ctrl",
      role: "button",
      roleGroup: "button_like",
      name: "Confirm",
      onClick: { go: "/confirmed" },
    });
    const opened = await openCommitGate(site, AUTHORIZED, {
      beforeDispatch: () => Promise.resolve(fail("evidence_write_failed")),
    });
    const before = await look(opened.eyes);
    const t = target("confirm_target", { role: "button", name: "Confirm" });
    const ctx = commitCtx(opened, before, t, NEVER_APPROVAL);
    const step = commitStepDef({ targetId: "confirm_target", risk: "irreversible", checkpoint: "cp_confirmed" });

    const result = await commitStep(step, [], ctx);
    expect(result).toEqual({ kind: "evidence_write_failed" });

    // The hands never acted: the screen is exactly as it was.
    const after = await look(opened.eyes);
    expect(after.url).toBe(before.url);
    await opened.gate.close();
  });

  test("commit_intent is written before the dispatch, and at most once", async () => {
    const site = siteWith({
      id: "ctrl",
      role: "button",
      roleGroup: "button_like",
      name: "Confirm",
      onClick: { go: "/confirmed" },
    });
    let calls = 0;
    let urlAtWrite: string | null = null;
    let eyesRef: Eyes | null = null;
    const opened = await openCommitGate(site, AUTHORIZED, {
      beforeDispatch: async () => {
        calls += 1;
        // Why: reading the screen from inside the hook proves the write happens strictly
        // before the click's navigation, not just before this call returns.
        const seen = eyesRef === null ? null : await eyesRef.observe();
        urlAtWrite = seen !== null && seen.ok ? seen.value.url : null;
        return ok(undefined);
      },
    });
    eyesRef = opened.eyes;
    const before = await look(opened.eyes);
    const t = target("confirm_target", { role: "button", name: "Confirm" });
    const ctx = commitCtx(opened, before, t, NEVER_APPROVAL);
    const step = commitStepDef({ targetId: "confirm_target", risk: "irreversible", checkpoint: "cp_confirmed" });

    const result = await commitStep(step, [], ctx);
    expect(calls).toBe(1);
    expect(urlAtWrite).toBe(before.url);
    expect(result).toMatchObject({ kind: "effect", effect: { commit: "confirmed" } });
    const after = await look(opened.eyes);
    expect(after.url).toBe(`${ORIGIN}/confirmed`);
    await opened.gate.close();
  });
});

describe("commitStep: the live re-check (section 4 §7.8 check 4)", () => {
  test("a control recorded 'Search' (idempotent) that now reads 'Delete' too is blocked", async () => {
    const site = siteWith({
      id: "ctrl",
      role: "button",
      roleGroup: "button_like",
      name: "Search",
      text: "Delete",
    });
    const opened = await openCommitGate(site, AUTHORIZED);
    const before = await look(opened.eyes);
    // Only `name` was recorded: this is exactly what voting used to find the control again.
    const t = target("search_target", { role: "button", name: "Search" });
    const ctx = commitCtx(opened, before, t, NEVER_APPROVAL);
    const step = commitStepDef({ targetId: "search_target", risk: "idempotent", checkpoint: "cp_never" });

    const result = await commitStep(step, [], ctx);
    expect(result).toEqual({
      kind: "effect",
      effect: { commit: "not_sent", performed_by: null, sent_at: null, attempts: [] },
    });
    expect(
      opened.lines.some(
        (l) => l.why.ref === "risk.live_mismatch" && l.data.decision === "blocked",
      ),
    ).toBe(true);
    const after = await look(opened.eyes);
    expect(after.url).toBe(before.url);
    await opened.gate.close();
  });

  test("no words at all, and no picture (M08), is blocked", async () => {
    const site = siteWith({
      id: "ctrl",
      role: "button",
      roleGroup: "button_like",
      label: "Confirm label",
    });
    const opened = await openCommitGate(site, AUTHORIZED);
    const before = await look(opened.eyes);
    // Recorded name and text; the live control carries neither, only its label (found through
    // that clue alone): the words that were recorded are gone.
    const t = target("confirm_target", {
      role: "button",
      name: "Confirm",
      text: "Confirm",
      label: "Confirm label",
    });
    const ctx = commitCtx(opened, before, t, NEVER_APPROVAL);
    const step = commitStepDef({ targetId: "confirm_target", risk: "idempotent", checkpoint: "cp_never" });

    const result = await commitStep(step, [], ctx);
    expect(result).toEqual({
      kind: "effect",
      effect: { commit: "not_sent", performed_by: null, sent_at: null, attempts: [] },
    });
    expect(opened.lines.some((l) => l.why.ref === "risk.live_mismatch")).toBe(true);
    await opened.gate.close();
  });

  test("same words as recorded: the confirmed flag stands, and the commit is sent", async () => {
    const site = siteWith({
      id: "ctrl",
      role: "button",
      roleGroup: "button_like",
      name: "Confirm",
      onClick: { go: "/confirmed" },
    });
    const opened = await openCommitGate(site, AUTHORIZED);
    const before = await look(opened.eyes);
    const t = target("confirm_target", { role: "button", name: "Confirm" });
    const ctx = commitCtx(opened, before, t, NEVER_APPROVAL);
    const step = commitStepDef({ targetId: "confirm_target", risk: "irreversible", checkpoint: "cp_confirmed" });

    const result = await commitStep(step, [], ctx);
    expect(result).toMatchObject({ kind: "effect", effect: { commit: "confirmed" } });
    expect(opened.lines.some((l) => l.why.ref === "risk.live_mismatch")).toBe(false);
    expect(
      opened.lines.some((l) => l.why.ref === "risk.authorized" && l.data.decision === "allowed"),
    ).toBe(true);
    await opened.gate.close();
  });
});

describe("commitStep: commit states follow what happened (section 2 §16.6)", () => {
  test("checkpoint true, with no navigation to a declared outcome: confirmed", async () => {
    const site = siteWith({
      id: "ctrl",
      role: "button",
      roleGroup: "button_like",
      name: "Confirm",
      onClick: { go: "/confirmed" },
    });
    const opened = await openCommitGate(site, AUTHORIZED);
    const before = await look(opened.eyes);
    const t = target("confirm_target", { role: "button", name: "Confirm" });
    const ctx = commitCtx(opened, before, t, NEVER_APPROVAL);
    const step = commitStepDef({ targetId: "confirm_target", risk: "irreversible", checkpoint: "cp_confirmed" });

    const result = await commitStep(step, [], ctx);
    expect(result).toMatchObject({
      kind: "effect",
      effect: { commit: "confirmed", performed_by: "bot" },
    });
    if (result.kind !== "effect") throw new Error("expected effect");
    expect(result.effect.sent_at).not.toBeNull();
    await opened.gate.close();
  });

  test("a declared outcome true, with no navigation to the checkpoint: refused", async () => {
    const site = siteWith({
      id: "ctrl",
      role: "button",
      roleGroup: "button_like",
      name: "Confirm",
      onClick: { go: "/refused" },
    });
    const opened = await openCommitGate(site, AUTHORIZED);
    const before = await look(opened.eyes);
    const t = target("confirm_target", { role: "button", name: "Confirm" });
    const ctx = commitCtx(opened, before, t, NEVER_APPROVAL);
    const step = commitStepDef({
      targetId: "confirm_target",
      risk: "irreversible",
      checkpoint: "cp_confirmed",
      outcomes: ["declined"],
    });

    const result = await commitStep(step, [DECLINED_OUTCOME], ctx);
    expect(result).toMatchObject({
      kind: "effect",
      effect: { commit: "refused", performed_by: "bot" },
    });
    await opened.gate.close();
  });

  test("neither true by the timeout: uncertain", async () => {
    const site = siteWith({
      id: "ctrl",
      role: "button",
      roleGroup: "button_like",
      name: "Confirm",
    });
    const opened = await openCommitGate(site, AUTHORIZED);
    const before = await look(opened.eyes);
    const t = target("confirm_target", { role: "button", name: "Confirm" });
    const ctx = commitCtx(opened, before, t, NEVER_APPROVAL);
    const step = commitStepDef({
      targetId: "confirm_target",
      risk: "irreversible",
      checkpoint: "cp_never",
      timeoutMs: 200,
    });

    const result = await commitStep(step, [], ctx);
    expect(result).toMatchObject({
      kind: "effect",
      effect: { commit: "uncertain", performed_by: "bot" },
    });
    await opened.gate.close();
  });

  test("a covered target stays dispatched: false, and the state is not_sent", async () => {
    const site = siteWith({
      id: "ctrl",
      role: "button",
      roleGroup: "button_like",
      name: "Confirm",
      onClick: { go: "/confirmed" },
      covered: true,
    });
    const opened = await openCommitGate(site, AUTHORIZED);
    const before = await look(opened.eyes);
    const t = target("confirm_target", { role: "button", name: "Confirm" });
    const ctx = commitCtx(opened, before, t, NEVER_APPROVAL);
    const step = commitStepDef({ targetId: "confirm_target", risk: "irreversible", checkpoint: "cp_confirmed" });

    const result = await commitStep(step, [], ctx);
    expect(result).toEqual({
      kind: "effect",
      effect: { commit: "not_sent", performed_by: null, sent_at: null, attempts: [] },
    });
    const after = await look(opened.eyes);
    expect(after.url).toBe(before.url);
    await opened.gate.close();
  });
});

describe("commitStep: approval (docs/decisions.md, M05)", () => {
  test("no valid authorization pauses; 'approved' proceeds and commits", async () => {
    const site = siteWith({
      id: "ctrl",
      role: "button",
      roleGroup: "button_like",
      name: "Confirm",
      onClick: { go: "/confirmed" },
    });
    const opened = await openCommitGate(site, UNAUTHORIZED);
    const before = await look(opened.eyes);
    const t = target("confirm_target", { role: "button", name: "Confirm" });
    const ctx = commitCtx(opened, before, t, approvalOf({ kind: "approved", staff: "op_022" }));
    const step = commitStepDef({ targetId: "confirm_target", risk: "irreversible", checkpoint: "cp_confirmed" });

    const result = await commitStep(step, [], ctx);
    expect(result).toMatchObject({
      kind: "effect",
      effect: { commit: "confirmed", performed_by: "bot" },
    });
    expect(
      opened.lines.some((l) => l.why.ref === "risk.human_approved" && l.data.decision === "allowed"),
    ).toBe(true);
    await opened.gate.close();
  });

  test.each([
    ["declined", { kind: "declined" as const }],
    ["timed_out", { kind: "timed_out" as const }],
    ["run_ended", { kind: "run_ended" as const }],
  ])("%s ends the commit not_sent, with no dispatch", async (_name, answer) => {
    const site = siteWith({
      id: "ctrl",
      role: "button",
      roleGroup: "button_like",
      name: "Confirm",
      onClick: { go: "/confirmed" },
    });
    const opened = await openCommitGate(site, UNAUTHORIZED);
    const before = await look(opened.eyes);
    const t = target("confirm_target", { role: "button", name: "Confirm" });
    const ctx = commitCtx(opened, before, t, approvalOf(answer));
    const step = commitStepDef({ targetId: "confirm_target", risk: "irreversible", checkpoint: "cp_confirmed" });

    const result = await commitStep(step, [], ctx);
    expect(result).toEqual({
      kind: "effect",
      effect: { commit: "not_sent", performed_by: null, sent_at: null, attempts: [] },
    });
    const after = await look(opened.eyes);
    expect(after.url).toBe(before.url);
    await opened.gate.close();
  });
});
