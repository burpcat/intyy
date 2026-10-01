// Proves rungs 2 and 3 inside `runLadder` on the snapshot fake, with the table fakes for jev and
// the reviewer: the closed helper window skips both; jev's buckets and thresholds; jev picking a
// handler (and the tie rule reaching it); the reviewer's one action, its landing, and the gate
// blocking it; the per-step and per-run call limits; and that jev never reports "refused" or
// touches the commit state. Design section 5 §8.2 (window), §8.7 (jev), §8.8 and §11 (reviewer),
// §10.7 (jev fails), §11.5 (limits); section 4 §7.9 (helpers). M09 tasks 4 and 5.
import { describe, expect, test } from "vitest";
import type { Condition } from "../../../src/core/model/artifact/conditions.js";
import type { ContractOutcome } from "../../../src/core/model/artifact/contract.js";
import type { Handler } from "../../../src/core/model/pack.js";
import type { LogLine } from "../../../src/core/orchestrator/run-log.js";
import {
  runLadder,
  type LadderDeps,
  type LadderInput,
  type LadderResult,
  type LadderTrouble,
} from "../../../src/core/replay/ladder.js";
import type { RungDeps } from "../../../src/core/replay/rung-input.js";
import { buildScreen } from "../../../src/core/discovery/observation.js";
import { openGate, type Gate, type GateRun } from "../../../src/core/safety/gate/gate.js";
import { redactionRules, Redactor } from "../../../src/core/safety/redaction/redactor.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { snapshotFactory, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { TableClassifier, type ClassifierScript } from "../../../src/fakes/table-classifier.js";
import { TableReviewer, type ReviewerScript } from "../../../src/fakes/table-reviewer.js";
import type {
  JevTroubleInput,
  JevTroubleOutput,
  ReviewerAction,
  ReviewerInput,
} from "../../../src/ports/models.js";
import type { Eyes } from "../../../src/ports/surface.js";
import { LEASE, gateConfig, testPolicy, testSecrets } from "../../contract/surface/gate-kit.js";

const ORIGIN = "http://127.0.0.1:9197";

function replayRun(declaredPaths: readonly string[]): GateRun {
  return {
    kind: "replay",
    readOnly: false,
    forceHuman: false,
    authorizationValid: () => true,
    declaredPaths,
  };
}

/** The scripted site: /main has a notice, a Close button to /form, and a text box. */
const SITE: FakeSite = {
  origin: ORIGIN,
  screens: {
    "/main": {
      elements: [
        {
          id: "notice",
          role: "generic",
          roleGroup: "container",
          text: "Branch profile review is pending.",
        },
        {
          id: "close",
          role: "button",
          roleGroup: "button_like",
          name: "Close",
          text: "Close",
          onClick: { go: "/form" },
        },
        {
          id: "box",
          role: "textbox",
          roleGroup: "text_entry",
          label: "Memo",
          field: { kind: "text", value: "" },
        },
      ],
    },
    "/form": {
      elements: [{ id: "form", role: "generic", roleGroup: "container", text: "The form" }],
    },
    "/other": {
      elements: [{ id: "o", role: "generic", roleGroup: "container", text: "Elsewhere" }],
    },
  },
};

type Scene = { eyes: Eyes; gate: Gate; closeId: string; boxId: string; close: () => Promise<void> };

/** Opens the gate over SITE at /main, allowing /main, /form, and /other. Navigation to /form is declared; /other is not. */
async function open(): Promise<Scene> {
  const policy = testPolicy(
    { allow: ["/main", "/form", "/other"], deny: [], irreversible: [] },
    {},
  );
  const opened = await openGate(snapshotFactory(SITE), gateConfig(ORIGIN, policy), {
    policy,
    redactor: new Redactor(redactionRules(policy)),
    run: replayRun(["/main", "/form"]),
    lease: () => LEASE,
    log: () => undefined,
    secrets: testSecrets(policy, {}),
  });
  if (!opened.ok) throw new Error(`open failed: ${opened.failure}`);
  const { eyes, gate } = opened.value;
  await gate.act({
    actor: "engine",
    lease: LEASE,
    action: { type: "navigate", to: "/main" },
    step: "setup",
  });
  const seen = await eyes.observe();
  if (!seen.ok) throw new Error("observe failed");
  const view = buildScreen(seen.value, new Redactor(redactionRules(policy)));
  const idOf = (name: string): string => {
    for (const [id, el] of view.elements)
      if (el.clues.name === name || el.clues.label === name) return id;
    throw new Error(`no element ${name}`);
  };
  return { eyes, gate, closeId: idOf("Close"), boxId: idOf("Memo"), close: () => gate.close() };
}

function loc(id: string, pattern: string): Condition {
  return { id, description: id, check: "location", pattern };
}
function txt(id: string, text: string): Condition {
  return { id, description: id, check: "text_visible", text, match: "contains" };
}

/** The task's conditions: a precondition no screen here shows, and a checkpoint at /form. */
const CONDITIONS = new Map<string, Condition>([
  ["start_shown", txt("start_shown", "Form ready")],
  ["done_shown", loc("done_shown", "/form")],
  ["on_main", loc("on_main", "/main")],
  ["never", txt("never", "This text never appears")],
]);
const OUTCOMES: ContractOutcome[] = [
  { code: "x", description: "The x outcome", condition: "never" },
];

const KYC: Handler = {
  class: "recoverable",
  id: "kyc_reminder",
  description: "The app interrupts with a KYC reminder.",
  detector: "kyc_shown",
  fixtures: { fire: [], no_fire: [] },
  response: [{ type: "navigate", location: "/form", risk: "idempotent" }],
  limits: { per_step: 3, per_run: 6 },
  on_exhausted: { class: "hard_failure", failure: "app_error" },
};
const PACK_CONDITIONS = new Map<string, Condition>([
  ["kyc_shown", txt("kyc_shown", "Never on screen")],
]);

const TROUBLE: LadderTrouble = {
  code: "checkpoint_timeout",
  message: "never arrived",
  phase: "checkpoint",
  risk: "idempotent",
  dispatched: true,
  transportEvent: null,
  ambiguous: false,
};

type Opts = {
  trouble?: LadderTrouble;
  handlers?: Handler[];
  packConditions?: Map<string, Condition>;
  outcomes?: ContractOutcome[];
  attempts?: Record<string, number>;
  precondition?: string;
  checkpoint?: string;
  stepRisk?: "idempotent" | "reversible" | "irreversible";
  jev?: ClassifierScript | null;
  reviewer?: ReviewerScript | null;
  reviewerCalls?: { step: number; run: number };
  inputs?: RungDeps["inputs"];
  noRungs?: boolean;
};

type Ran = {
  result: LadderResult;
  lines: LogLine[];
  jev: TableClassifier | null;
  rev: TableReviewer | null;
  reviewerCalled: () => number;
  recorded: string[];
};

/** Runs one ladder with the table fakes in place. */
async function run(scene: Scene, o: Opts = {}): Promise<Ran> {
  const lines: LogLine[] = [];
  const recorded: string[] = [];
  let calls = 0;
  let seq = 40;
  const jev = o.jev ? new TableClassifier(o.jev) : null;
  const rev = o.reviewer ? new TableReviewer(o.reviewer) : null;
  const handlers = o.handlers ?? [KYC];
  const rungs: RungDeps = {
    jev,
    reviewer: rev,
    cutoffs: { handler_min: 0.8, outcome_min: 0.95 },
    recorder: (who) => ({
      request: `llm/00041_${who}_request.json`,
      record: (part) => {
        recorded.push(`${who}:${part}`);
        return Promise.resolve(true);
      },
    }),
    sendScreenshots: false,
    steps: new Map([
      ["click_thing", { intent: "Open the form", action: "click", timeoutMs: 1000 }],
    ]),
    inputs: o.inputs ?? new Map(),
    allowed: {
      actions: ["click", "type", "press", "navigate"],
      keys: ["Tab", "Escape"],
      paths: ["/main", "/form"],
    },
    commit: () => "not_sent",
    reviewerCalls: o.reviewerCalls ?? { step: 0, run: 0 },
    onReviewerCall: () => {
      calls += 1;
    },
    nextSeq: () => seq++,
  };
  const policy = testPolicy({ allow: ["/"], deny: [], irreversible: [] }, {});
  const deps: LadderDeps = {
    eyes: scene.eyes,
    gate: scene.gate,
    clock: new SteppingClock(),
    redactor: new Redactor(redactionRules(policy)),
    lease: LEASE,
    log: (l) => lines.push(l),
    taskCtx: { targets: new Map(), conditions: CONDITIONS },
    packCtx: { targets: new Map(), conditions: o.packConditions ?? PACK_CONDITIONS },
    frozen: {
      handlers,
      handlerScope: new Map(handlers.map((h) => [h.id, { level: "global" as const }])),
      targets: [],
      conditions: [],
    },
    packTargets: new Map(),
    lastGoodPath: "/main",
    runPrelude: () => Promise.reject(new Error("runPrelude should not be called")),
    ...(o.noRungs === true ? {} : { rungs }),
  };
  const input: LadderInput = {
    stepId: "click_thing",
    stepIndex: 0,
    steps: [
      {
        id: "click_thing",
        precondition: o.precondition ?? "start_shown",
        checkpoint: o.checkpoint ?? "done_shown",
        risk: o.stepRisk ?? "idempotent",
      },
    ],
    floorIndex: 0,
    trouble: o.trouble ?? TROUBLE,
    stepOutcomes: o.outcomes ?? OUTCOMES,
    limits: {
      retriesUsedThisStep: 2,
      handlerAttemptsThisStep: o.attempts ?? {},
      handlerAttemptsThisRun: 0,
      signInRunsUsed: 0,
      ladderEntriesUsed: 0,
      rewindsUsed: 0,
    },
    captureFiles: [],
  };
  return {
    result: await runLadder(input, deps),
    lines,
    jev,
    rev,
    reviewerCalled: () => calls,
    recorded,
  };
}

/** A scene for one test, always closed after. */
async function withScene(fn: (s: Scene) => Promise<void>): Promise<void> {
  const scene = await open();
  try {
    await fn(scene);
  } finally {
    await scene.close();
  }
}

/** The first input the reviewer fake was sent. */
function reviewerSeen(r: Ran): ReviewerInput {
  const seen = r.rev?.seen[0];
  if (seen?.kind !== "fixStep") throw new Error("the reviewer was not asked");
  return seen.input as ReviewerInput;
}
/** The first input the jev fake was sent. */
function jevSeen(r: Ran): JevTroubleInput {
  const seen = r.jev?.seen[0];
  if (seen?.kind !== "trouble") throw new Error("jev was not asked");
  return seen.input as JevTroubleInput;
}
const jevRow = (a: JevTroubleOutput): ClassifierScript => ({
  trouble: [{ when: {}, reply: { answer: a } }],
});
const answer = (a: Partial<JevTroubleOutput>): JevTroubleOutput => ({
  bucket: "needs_review",
  handler: null,
  outcome: null,
  confidence: 0.5,
  ...a,
});
const warnings = (r: Ran): string[] =>
  r.lines.filter((l) => l.event === "warning").map((l) => (l.data as { code: string }).code);
const ladderLines = (r: Ran) =>
  r.lines.filter((l) => l.event === "ladder").map((l) => l.data as Record<string, unknown>);

describe("the helper window (section 5 §8.2, section 4 §7.9)", () => {
  test("a closed window skips both rungs: no model is called", async () => {
    await withScene(async (s) => {
      const r = await run(s, {
        trouble: { ...TROUBLE, risk: "reversible", dispatched: true },
        jev: jevRow(answer({ bucket: "unsafe" })),
        reviewer: { fixStep: [] },
      });
      expect(r.result.kind).toBe("climb");
      expect(r.jev?.seen).toEqual([]);
      expect(r.rev?.seen).toEqual([]);
      expect(r.reviewerCalled()).toBe(0);
    });
  });

  test("dispatched:false opens the window even for a reversible step", async () => {
    await withScene(async (s) => {
      const r = await run(s, {
        trouble: { ...TROUBLE, risk: "reversible", dispatched: false },
        jev: jevRow(answer({})),
      });
      expect(r.jev?.seen).toHaveLength(1);
    });
  });

  test("with no rungs at all a climb goes straight to rung 4", async () => {
    await withScene(async (s) => {
      const r = await run(s, { noRungs: true });
      expect(r.result.kind).toBe("climb");
    });
  });
});

describe("rung 2: jev (section 5 §8.7)", () => {
  test("an outcome at 0.97 ends the run as business_outcome, decided by jev", async () => {
    await withScene(async (s) => {
      const r = await run(s, {
        jev: jevRow(answer({ bucket: "outcome", outcome: "x", confidence: 0.97 })),
      });
      expect(r.result).toMatchObject({ kind: "business_outcome", code: "x", decidedBy: "jev" });
      expect(ladderLines(r)).toContainEqual(
        expect.objectContaining({
          rung: 2,
          verdict: "business_outcome",
          bucket: "outcome",
          confidence: 0.97,
          threshold: 0.95,
          input: "llm/00041_jev_request.json",
        }),
      );
    });
  });

  test("an outcome at 0.94 climbs to the reviewer", async () => {
    await withScene(async (s) => {
      const r = await run(s, {
        jev: jevRow(answer({ bucket: "outcome", outcome: "x", confidence: 0.94 })),
        reviewer: { fixStep: [{ when: {}, reply: { answer: { give_up: true, reason: "no" } } }] },
      });
      expect(r.result.kind).toBe("climb");
      expect(r.rev?.seen).toHaveLength(1);
    });
  });

  test("a handler at 0.79 climbs; at 0.80 it applies and recovers via jev on rung 2", async () => {
    await withScene(async (s) => {
      const low = await run(s, {
        jev: jevRow(answer({ bucket: "handler", handler: "kyc_reminder", confidence: 0.79 })),
      });
      expect(low.result.kind).toBe("climb");
    });
    await withScene(async (s) => {
      const r = await run(s, {
        jev: jevRow(answer({ bucket: "handler", handler: "kyc_reminder", confidence: 0.8 })),
      });
      expect(r.result).toMatchObject({
        kind: "recovered",
        recovery: { via: "jev", ref: "kyc_reminder" },
      });
      expect(ladderLines(r)).toContainEqual(
        expect.objectContaining({
          rung: 2,
          verdict: "recovered",
          handler: "kyc_reminder",
          bucket: "handler",
          confidence: 0.8,
          threshold: 0.8,
          input: "llm/00041_jev_request.json",
        }),
      );
      // Why: section 5 §8.7, "jev may pick a handler whose detector did not match."
      expect(warnings(r)).toContain("detector_missed");
    });
  });

  test("a handler picked out of attempts uses its own on_exhausted", async () => {
    await withScene(async (s) => {
      const r = await run(s, {
        jev: jevRow(answer({ bucket: "handler", handler: "kyc_reminder", confidence: 0.9 })),
        attempts: { kyc_reminder: 3 },
      });
      expect(r.result).toMatchObject({
        kind: "hard_failure",
        code: "app_error",
        ladderRef: "on_exhausted",
      });
    });
  });

  test("a tie at rung 1 reaches jev, which sees the tied IDs; picking one logs no detector_missed", async () => {
    await withScene(async (s) => {
      const twin: Handler = { ...KYC, id: "kyc_twin" };
      const both = new Map<string, Condition>([
        ["kyc_shown", txt("kyc_shown", "Branch profile review")],
      ]);
      const r = await run(s, {
        handlers: [KYC, twin],
        packConditions: both,
        jev: jevRow(answer({ bucket: "handler", handler: "kyc_twin", confidence: 0.9 })),
      });
      expect(r.jev?.seen).toHaveLength(1);
      expect([...jevSeen(r).tied].sort()).toEqual(["kyc_reminder", "kyc_twin"]);
      expect(r.result).toMatchObject({
        kind: "recovered",
        recovery: { via: "jev", ref: "kyc_twin" },
      });
      expect(warnings(r)).not.toContain("detector_missed");
    });
  });

  test.each([
    ["an unknown handler", answer({ bucket: "handler", handler: "nope", confidence: 1 })],
    ["an undeclared outcome", answer({ bucket: "outcome", outcome: "nope", confidence: 1 })],
  ])("%s warns classifier_invalid_output and climbs to the reviewer", async (_n, a) => {
    await withScene(async (s) => {
      const r = await run(s, {
        jev: jevRow(a),
        reviewer: { fixStep: [{ when: {}, reply: { answer: { give_up: true, reason: "no" } } }] },
      });
      expect(warnings(r)).toContain("classifier_invalid_output");
      expect(r.rev?.seen).toHaveLength(1);
      expect(reviewerSeen(r).jev).toBeNull();
    });
  });

  test("with the reviewer off, a jev climb is a rung 4 climb", async () => {
    await withScene(async (s) => {
      const r = await run(s, { jev: jevRow(answer({ bucket: "needs_review", confidence: 0.6 })) });
      expect(r.result.kind).toBe("climb");
      expect(ladderLines(r).at(-1)).toMatchObject({ rung: 2, next: "takeover" });
    });
  });

  test("unsafe at a low confidence is a takeover for unsafe_state", async () => {
    await withScene(async (s) => {
      const r = await run(s, { jev: jevRow(answer({ bucket: "unsafe", confidence: 0.1 })) });
      expect(r.result.kind).toBe("unsafe");
    });
  });

  test("needs_review passes jev's bucket and confidence to the reviewer as a hint", async () => {
    await withScene(async (s) => {
      const r = await run(s, {
        jev: jevRow(answer({ bucket: "needs_review", confidence: 0.71 })),
        reviewer: { fixStep: [{ when: {}, reply: { answer: { give_up: true, reason: "no" } } }] },
      });
      expect(reviewerSeen(r).jev).toEqual({
        bucket: "needs_review",
        confidence: 0.71,
      });
    });
  });

  test.each([
    ["timeout", { failure: "timeout" }, "classifier_unavailable"],
    ["unavailable", { failure: "unavailable" }, "classifier_unavailable"],
    ["invalid_output", { failure: "invalid_output" }, "classifier_invalid_output"],
    ["bad raw output", { raw: { bucket: "x" } }, "classifier_invalid_output"],
  ])("a jev %s warns %s, gives no hint, and the ladder goes on", async (_n, reply, code) => {
    await withScene(async (s) => {
      const r = await run(s, {
        jev: { trouble: [{ when: {}, reply: reply as { failure: "timeout" } }] },
        reviewer: { fixStep: [{ when: {}, reply: { answer: { give_up: true, reason: "no" } } }] },
      });
      expect(warnings(r)).toContain(code);
      expect(reviewerSeen(r).jev).toBeNull();
    });
  });

  test("the jev request is recorded before its reply", async () => {
    await withScene(async (s) => {
      const r = await run(s, { jev: jevRow(answer({ bucket: "unsafe", confidence: 0.1 })) });
      expect(r.recorded).toEqual(["jev:request", "jev:reply"]);
    });
  });
});

describe("rung 3: the reviewer (section 5 §8.8, §11)", () => {
  const act = (action: ReviewerAction): ReviewerScript => ({
    fixStep: [
      {
        when: {},
        reply: {
          answer: { action, reason: "A notice covers the page.", expected: "The form shows." },
        },
      },
    ],
  });

  test("click on Close lands on the checkpoint: recovered via reviewer, ref seq:<n>, patch_needed", async () => {
    await withScene(async (s) => {
      const r = await run(s, { reviewer: act({ type: "click", element: s.closeId }) });
      expect(r.result).toMatchObject({
        kind: "recovered",
        // Section 5 §8.6 rule 1: the checkpoint passed, so the run goes on with the NEXT step.
        index: 1,
        recovery: { via: "reviewer", ref: "seq:40" },
      });
      // Section 5 §11.4: the step's own action (a click) on another control, checkpoint passed.
      expect(warnings(r)).toEqual(["patch_needed"]);
      expect(r.lines.find((l) => l.event === "action")).toMatchObject({
        by: "reviewer",
        data: { type: "click", expected: "The form shows." },
      });
      expect(r.reviewerCalled()).toBe(1);
      expect(ladderLines(r).at(-1)).toMatchObject({
        rung: 3,
        verdict: "recovered",
        input: "llm/00041_reviewer_request.json",
      });
    });
  });

  test("a fix that is not the step's own action type logs handler_needed", async () => {
    await withScene(async (s) => {
      // The reviewer navigates to /form (declared): the checkpoint passes, the action is not a click.
      const r = await run(s, { reviewer: act({ type: "navigate", location: "/form" }) });
      expect(r.result).toMatchObject({ kind: "recovered", recovery: { via: "reviewer" } });
      expect(warnings(r)).toEqual(["handler_needed"]);
    });
  });

  test("navigate to an undeclared path is blocked: unsafe", async () => {
    await withScene(async (s) => {
      const r = await run(s, { reviewer: act({ type: "navigate", location: "/other" }) });
      expect(r.result.kind).toBe("unsafe");
    });
  });

  test("a type value that is not {input.x} is blocked: unsafe", async () => {
    await withScene(async (s) => {
      const r = await run(s, {
        reviewer: act({ type: "type", element: s.boxId, value: "free text" }),
      });
      expect(r.result.kind).toBe("unsafe");
    });
  });

  test("give_up climbs", async () => {
    await withScene(async (s) => {
      const r = await run(s, {
        reviewer: { fixStep: [{ when: {}, reply: { answer: { give_up: true, reason: "no" } } }] },
      });
      expect(r.result.kind).toBe("climb");
      expect(ladderLines(r).at(-1)).toMatchObject({ rung: 3, verdict: "climb", next: "takeover" });
    });
  });

  test.each([
    ["a failed call", { failure: "timeout" }],
    ["an invalid answer", { raw: { nope: 1 } }],
  ])("%s climbs", async (_n, reply) => {
    await withScene(async (s) => {
      const r = await run(s, {
        reviewer: { fixStep: [{ when: {}, reply: reply as { failure: "timeout" } }] },
      });
      expect(r.result.kind).toBe("climb");
    });
  });

  test("an element that is not on the screen climbs", async () => {
    await withScene(async (s) => {
      const r = await run(s, { reviewer: act({ type: "click", element: "e999" }) });
      expect(r.result.kind).toBe("climb");
    });
  });

  test("a press that lands nowhere climbs (no landing)", async () => {
    await withScene(async (s) => {
      const r = await run(s, { reviewer: act({ type: "press", key: "Tab" }) });
      expect(r.result.kind).toBe("climb");
      expect(r.lines.filter((l) => l.event === "warning")).toEqual([]);
    });
  });

  test("a press that leaves the precondition showing counts as landed (rerun the step)", async () => {
    await withScene(async (s) => {
      const r = await run(s, {
        precondition: "on_main",
        reviewer: act({ type: "press", key: "Tab" }),
      });
      expect(r.result).toMatchObject({
        kind: "recovered",
        index: 0,
        recovery: { via: "reviewer" },
      });
    });
  });

  describe("an irreversible step the bot never sent (CLAUDE.md: never retry an irreversible step)", () => {
    const unsent: LadderTrouble = { ...TROUBLE, risk: "irreversible", dispatched: false };

    test("its checkpoint already showing climbs: never re-run, never skipped", async () => {
      await withScene(async (s) => {
        const r = await run(s, {
          trouble: unsent,
          stepRisk: "irreversible",
          checkpoint: "on_main",
          reviewer: act({ type: "press", key: "Tab" }),
        });
        expect(r.result.kind).toBe("climb");
        expect(JSON.stringify(r.lines.filter((l) => l.event === "ladder"))).toContain(
          "irreversible_not_sent",
        );
        expect(ladderLines(r).some((l) => l.verdict === "recovered")).toBe(false);
      });
    });

    test("only its precondition showing re-runs this step", async () => {
      await withScene(async (s) => {
        const r = await run(s, {
          trouble: unsent,
          stepRisk: "irreversible",
          precondition: "on_main",
          reviewer: act({ type: "press", key: "Tab" }),
        });
        expect(r.result).toMatchObject({
          kind: "recovered",
          index: 0,
          recovery: { via: "reviewer" },
        });
      });
    });
  });

  test("the reviewer reads element IDs, the allowed lists, and the commit state", async () => {
    await withScene(async (s) => {
      const r = await run(s, { reviewer: act({ type: "click", element: s.closeId }) });
      const i = reviewerSeen(r);
      expect(i.screen.elements.find((e) => e.name === "Close")?.id).toBe(s.closeId);
      expect(i.allowed.keys).toEqual(["Tab", "Escape"]);
      expect(i.commit).toBe("not_sent");
      expect(i.screenshot).toBeNull();
    });
  });

  test.each([
    ["one call already used on this step", { step: 1, run: 1 }],
    ["two calls already used in this run", { step: 0, run: 2 }],
  ])("%s: no reviewer call", async (_n, calls) => {
    await withScene(async (s) => {
      const r = await run(s, {
        reviewer: act({ type: "click", element: s.closeId }),
        reviewerCalls: calls,
      });
      expect(r.result.kind).toBe("climb");
      expect(r.rev?.seen).toEqual([]);
      expect(r.reviewerCalled()).toBe(0);
    });
  });

  test("onReviewerCall fires once per call, even when the call fails", async () => {
    await withScene(async (s) => {
      const r = await run(s, {
        reviewer: { fixStep: [{ when: {}, reply: { failure: "unavailable" } }] },
      });
      expect(r.reviewerCalled()).toBe(1);
    });
  });
});

describe("safety: jev never says refused and never sets the commit state", () => {
  test("no ladder result or log line anywhere holds the word refused", async () => {
    const answers = [
      answer({ bucket: "outcome", outcome: "x", confidence: 0.97 }),
      answer({ bucket: "handler", handler: "kyc_reminder", confidence: 0.9 }),
      answer({ bucket: "unsafe", confidence: 0.2 }),
      answer({ bucket: "needs_review", confidence: 0.5 }),
    ];
    for (const a of answers) {
      await withScene(async (s) => {
        const r = await run(s, { jev: jevRow(a) });
        expect(JSON.stringify({ result: r.result, lines: r.lines })).not.toContain("refused");
        // The ladder result has no commit or effect field to carry one.
        expect(Object.keys(r.result)).not.toContain("effect");
        expect(Object.keys(r.result)).not.toContain("commit");
      });
    }
  });

  test("a jev outcome that is not a declared one is not accepted as an outcome", async () => {
    await withScene(async (s) => {
      const r = await run(s, {
        jev: jevRow(answer({ bucket: "outcome", outcome: "refused", confidence: 1 })),
      });
      expect(r.result.kind).not.toBe("business_outcome");
    });
  });
});
