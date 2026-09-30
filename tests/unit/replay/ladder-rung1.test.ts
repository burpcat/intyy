// Proves rung 1's ordering and edge rules on the snapshot fake (design section 5 §8.3, §8.4,
// §9.4, §14; section 7 §7.3): declared outcomes beat handlers, handlers beat retry, a known
// screen with no progress fails (never climbs) unless its precondition is location-only, an
// undeclared pack outcome ends `undeclared_outcome`, transport trouble prefers `retry.transport`
// unless a handler names the error page first, and the bank's blank/hang/unavailable/logout
// faults each recover at rung 1 (docs/decisions.md, M06: only these four are tested here, not
// live, since `CONTRACT.md` names no fault kind for them). M06 task 2/3.
import { describe, expect, test } from "vitest";
import { runLadder, matchDetectors, type LadderDeps, type LadderInput, type LadderTrouble } from "../../../src/core/replay/ladder.js";
import type { Condition } from "../../../src/core/model/artifact/conditions.js";
import type { ContractOutcome } from "../../../src/core/model/artifact/contract.js";
import type { Handler, PackTarget } from "../../../src/core/model/pack.js";
import type { LogLine } from "../../../src/core/orchestrator/run-log.js";
import { openGate, type Gate, type GateLine, type GateRun } from "../../../src/core/safety/gate/gate.js";
import { redactionRules, Redactor } from "../../../src/core/safety/redaction/redactor.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { snapshotFactory, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { fromObservation } from "../../../src/core/targets/screen.js";
import type { Eyes } from "../../../src/ports/surface.js";
import { LEASE, gateConfig, testPolicy, testSecrets } from "../../contract/surface/gate-kit.js";

const ORIGIN = "http://127.0.0.1:9198";

/** A replay run, authorized, with `declaredPaths` for the handler navigations a test needs. */
function replayRun(declaredPaths: readonly string[]): GateRun {
  return { kind: "replay", readOnly: false, forceHuman: false, authorizationValid: () => true, declaredPaths };
}

/** Opens a gate over `site`, allowing every path under `allow`. Every gate line lands in `lines`. */
async function open(
  site: FakeSite,
  allow: readonly string[],
  declaredPaths: readonly string[],
): Promise<{ eyes: Eyes; gate: Gate; lines: GateLine[]; close: () => Promise<void> }> {
  const policy = testPolicy({ allow: [...allow], deny: [], irreversible: [] }, {});
  const lines: GateLine[] = [];
  const opened = await openGate(snapshotFactory(site), gateConfig(ORIGIN, policy), {
    policy,
    redactor: new Redactor(redactionRules(policy)),
    run: replayRun(declaredPaths),
    lease: () => LEASE,
    log: (l) => lines.push(l),
    secrets: testSecrets(policy, {}),
  });
  if (!opened.ok) throw new Error(`open failed: ${opened.failure}`);
  const { eyes, gate } = opened.value;
  // Opening always loads `/` first (the fake browser's own start page); every scenario below
  // puts its screen at `/main`, so move there before the test's own trouble begins.
  await gate.act({ actor: "engine", lease: LEASE, action: { type: "navigate", to: "/main" }, step: "setup" });
  return { eyes, gate, lines, close: () => gate.close() };
}

/** Builds `LadderDeps`, defaulted to an empty frozen set and a `runPrelude` that fails the test
 * if a scenario calls it by mistake. */
function ladderDeps(opts: {
  eyes: Eyes;
  gate: Gate;
  log: (l: LogLine) => void;
  taskConditions: Map<string, Condition>;
  packConditions?: Map<string, Condition>;
  packTargets?: Map<string, PackTarget>;
  handlers?: Handler[];
  lastGoodPath?: string;
  runPrelude?: () => Promise<boolean>;
}): LadderDeps {
  return {
    eyes: opts.eyes,
    gate: opts.gate,
    clock: new SteppingClock(),
    redactor: new Redactor(redactionRules(testPolicy({ allow: ["/"], deny: [], irreversible: [] }, {}))),
    lease: LEASE,
    log: opts.log,
    taskCtx: { targets: new Map(), conditions: opts.taskConditions },
    packCtx: { targets: new Map(), conditions: opts.packConditions ?? new Map() },
    frozen: {
      handlers: opts.handlers ?? [],
      handlerScope: new Map((opts.handlers ?? []).map((h) => [h.id, { level: "global" as const }])),
      targets: [],
      conditions: [],
    },
    packTargets: opts.packTargets ?? new Map(),
    lastGoodPath: opts.lastGoodPath ?? "/main",
    runPrelude: opts.runPrelude ?? (() => Promise.reject(new Error("runPrelude should not be called"))),
  };
}

/** A location condition. */
function loc(id: string, pattern: string): Condition {
  return { id, description: id, check: "location", pattern };
}

/** A text condition. */
function txt(id: string, text: string): Condition {
  return { id, description: id, check: "text_visible", text, match: "contains" };
}

const START: LadderTrouble = {
  code: "checkpoint_timeout",
  message: "never arrived",
  phase: "checkpoint",
  risk: "idempotent",
  dispatched: true,
  transportEvent: null,
  ambiguous: false,
};

describe("rung order (section 5 §8.4): outcomes, then handlers, then retry, then climb", () => {
  test("a declared outcome beats a handler whose detector also matches", async () => {
    const site: FakeSite = {
      origin: ORIGIN,
      screens: { "/main": { elements: [{ id: "banner", role: "generic", roleGroup: "container", text: "Special text" }] } },
    };
    const { eyes, gate, close } = await open(site, ["/main"], []);
    try {
      const taskConditions = new Map<string, Condition>([
        ["start_shown", loc("start_shown", "/main")],
        ["done_shown", loc("done_shown", "/done")],
        ["outcome_cond", txt("outcome_cond", "Special text")],
      ]);
      const handlers: Handler[] = [
        {
          class: "business_outcome",
          id: "h_special",
          description: "h_special",
          detector: "outcome_cond",
          fixtures: { fire: [], no_fire: [] },
          outcome: { code: "should_never_win", description: "never" },
        },
      ];
      const stepOutcomes: ContractOutcome[] = [{ code: "special_seen", description: "special", condition: "outcome_cond" }];
      const lines: LogLine[] = [];
      const input: LadderInput = {
        stepId: "click_thing",
        stepIndex: 0,
        steps: [{ id: "click_thing", precondition: "start_shown", checkpoint: "done_shown", risk: "idempotent" }],
        floorIndex: 0,
        trouble: START,
        stepOutcomes,
        limits: { retriesUsedThisStep: 0, handlerAttemptsThisStep: {}, handlerAttemptsThisRun: 0, signInRunsUsed: 0, ladderEntriesUsed: 0, rewindsUsed: 0 },
        captureFiles: [],
      };
      const result = await runLadder(input, ladderDeps({ eyes, gate, log: (l) => lines.push(l), taskConditions, handlers, packConditions: taskConditions }));
      expect(result).toMatchObject({ kind: "business_outcome", code: "special_seen" });
      const ladderLine = lines.find((l) => l.event === "ladder");
      expect(ladderLine?.data).toMatchObject({ matched: [], handler: null, verdict: "business_outcome" });
    } finally {
      await close();
    }
  });

  test("a handler beats retry when both a detector and a resumable screen are present", async () => {
    const site: FakeSite = {
      origin: ORIGIN,
      screens: {
        "/main": {
          elements: [{ id: "banner", role: "generic", roleGroup: "container", text: "Reminder banner" }],
        },
      },
    };
    const { eyes, gate, close } = await open(site, ["/main"], ["/main"]);
    try {
      const taskConditions = new Map<string, Condition>([
        ["start_shown", loc("start_shown", "/main")],
        ["done_shown", loc("done_shown", "/done")],
      ]);
      const packConditions = new Map<string, Condition>([["banner_shown", txt("banner_shown", "Reminder banner")]]);
      const handlers: Handler[] = [
        {
          class: "recoverable",
          id: "clear_banner",
          description: "clear_banner",
          detector: "banner_shown",
          fixtures: { fire: [], no_fire: [] },
          response: [{ type: "navigate", location: "/main", risk: "idempotent" }],
          limits: { per_step: 3, per_run: 6 },
          on_exhausted: { class: "hard_failure", failure: "app_error" },
        },
      ];
      const input: LadderInput = {
        stepId: "click_thing",
        stepIndex: 0,
        steps: [{ id: "click_thing", precondition: "start_shown", checkpoint: "done_shown", risk: "idempotent" }],
        floorIndex: 0,
        trouble: START,
        stepOutcomes: [],
        limits: { retriesUsedThisStep: 0, handlerAttemptsThisStep: {}, handlerAttemptsThisRun: 0, signInRunsUsed: 0, ladderEntriesUsed: 0, rewindsUsed: 0 },
        captureFiles: [],
      };
      const result = await runLadder(input, ladderDeps({ eyes, gate, log: () => undefined, taskConditions, packConditions, handlers }));
      expect(result).toMatchObject({ kind: "recovered", recovery: { via: "handler", ref: "clear_banner" } });
    } finally {
      await close();
    }
  });

  test("no handler matches: retry runs the resume rule", async () => {
    const site: FakeSite = { origin: ORIGIN, screens: { "/main": { elements: [] } } };
    const { eyes, gate, close } = await open(site, ["/main"], []);
    try {
      const taskConditions = new Map<string, Condition>([
        ["start_shown", loc("start_shown", "/main")],
        ["done_shown", loc("done_shown", "/done")],
      ]);
      const input: LadderInput = {
        stepId: "click_thing",
        stepIndex: 0,
        steps: [{ id: "click_thing", precondition: "start_shown", checkpoint: "done_shown", risk: "idempotent" }],
        floorIndex: 0,
        trouble: START,
        stepOutcomes: [],
        limits: { retriesUsedThisStep: 0, handlerAttemptsThisStep: {}, handlerAttemptsThisRun: 0, signInRunsUsed: 0, ladderEntriesUsed: 0, rewindsUsed: 0 },
        captureFiles: [],
      };
      const result = await runLadder(input, ladderDeps({ eyes, gate, log: () => undefined, taskConditions }));
      expect(result).toMatchObject({ kind: "recovered", recovery: { via: "retry", ref: "retry.idempotent" } });
    } finally {
      await close();
    }
  });
});

describe("pre-commit sweep shares matchDetectors with rung 1 (section 5 §8.3)", () => {
  test("the ladder's own `matched` list is exactly what matchDetectors answers on the same screen", async () => {
    const site: FakeSite = {
      origin: ORIGIN,
      screens: { "/main": { elements: [{ id: "b", role: "generic", roleGroup: "container", text: "Known popup" }] } },
    };
    const { eyes, gate, close } = await open(site, ["/main"], []);
    try {
      const taskConditions = new Map<string, Condition>([
        ["start_shown", loc("start_shown", "/main")],
        ["done_shown", loc("done_shown", "/done")],
      ]);
      const packConditions = new Map<string, Condition>([["popup_shown", txt("popup_shown", "Known popup")]]);
      const handlers: Handler[] = [
        { class: "needs_human", id: "unknown_popup", description: "unknown_popup", detector: "popup_shown", fixtures: { fire: [], no_fire: [] }, operator_note: "look" },
      ];
      const observed = await eyes.observe();
      if (!observed.ok) throw new Error("observe failed");
      const direct = matchDetectors(handlers, fromObservation(observed.value), { targets: new Map(), conditions: packConditions });

      const lines: LogLine[] = [];
      const input: LadderInput = {
        stepId: "click_thing",
        stepIndex: 0,
        steps: [{ id: "click_thing", precondition: "start_shown", checkpoint: "done_shown", risk: "idempotent" }],
        floorIndex: 0,
        trouble: START,
        stepOutcomes: [],
        limits: { retriesUsedThisStep: 0, handlerAttemptsThisStep: {}, handlerAttemptsThisRun: 0, signInRunsUsed: 0, ladderEntriesUsed: 0, rewindsUsed: 0 },
        captureFiles: [],
      };
      await runLadder(input, ladderDeps({ eyes, gate, log: (l) => lines.push(l), taskConditions, packConditions, handlers }));
      const ladderLine = lines.find((l) => l.event === "ladder");
      expect(direct).toEqual(["unknown_popup"]);
      expect(ladderLine?.data).toMatchObject({ matched: direct });
    } finally {
      await close();
    }
  });
});

describe("known screen, no progress (section 5 §8.4 step 5, docs/decisions.md M06)", () => {
  test("a non-location precondition still passing, and no handler: hard failure with the original code, no climb", async () => {
    const site: FakeSite = { origin: ORIGIN, screens: { "/main": { elements: [{ id: "b", role: "generic", roleGroup: "container", text: "Start page" }] } } };
    const { eyes, gate, close } = await open(site, ["/main"], []);
    try {
      const taskConditions = new Map<string, Condition>([
        ["start_shown", txt("start_shown", "Start page")],
        ["done_shown", loc("done_shown", "/done")],
      ]);
      const input: LadderInput = {
        stepId: "click_thing",
        stepIndex: 0,
        steps: [{ id: "click_thing", precondition: "start_shown", checkpoint: "done_shown", risk: "idempotent" }],
        floorIndex: 0,
        trouble: { ...START, code: "checkpoint_timeout", message: "still stuck" },
        stepOutcomes: [],
        limits: { retriesUsedThisStep: 2, handlerAttemptsThisStep: {}, handlerAttemptsThisRun: 0, signInRunsUsed: 0, ladderEntriesUsed: 0, rewindsUsed: 0 },
        captureFiles: [],
      };
      const result = await runLadder(input, ladderDeps({ eyes, gate, log: () => undefined, taskConditions }));
      expect(result).toMatchObject({ kind: "hard_failure", code: "checkpoint_timeout", ladderRef: "retry_limit" });
    } finally {
      await close();
    }
  });

  test("a location-only precondition never counts as known: climbs instead of failing", async () => {
    const site: FakeSite = { origin: ORIGIN, screens: { "/main": { elements: [] } } };
    const { eyes, gate, close } = await open(site, ["/main"], []);
    try {
      const taskConditions = new Map<string, Condition>([
        ["start_shown", loc("start_shown", "/main")],
        ["done_shown", loc("done_shown", "/done")],
      ]);
      const input: LadderInput = {
        stepId: "click_thing",
        stepIndex: 0,
        steps: [{ id: "click_thing", precondition: "start_shown", checkpoint: "done_shown", risk: "idempotent" }],
        floorIndex: 0,
        trouble: { ...START, code: "checkpoint_timeout", message: "still stuck" },
        stepOutcomes: [],
        limits: { retriesUsedThisStep: 2, handlerAttemptsThisStep: {}, handlerAttemptsThisRun: 0, signInRunsUsed: 0, ladderEntriesUsed: 0, rewindsUsed: 0 },
        captureFiles: [],
      };
      const result = await runLadder(input, ladderDeps({ eyes, gate, log: () => undefined, taskConditions }));
      expect(result.kind).toBe("climb");
    } finally {
      await close();
    }
  });
});

describe("undeclared_outcome (section 5 §9.4)", () => {
  function scenario(declared: boolean) {
    return async (): Promise<void> => {
      const site: FakeSite = { origin: ORIGIN, screens: { "/main": { elements: [{ id: "b", role: "generic", roleGroup: "container", text: "Limit reached" }] } } };
      const { eyes, gate, close } = await open(site, ["/main"], []);
      try {
        const taskConditions = new Map<string, Condition>([
          ["start_shown", loc("start_shown", "/main")],
          ["done_shown", loc("done_shown", "/done")],
          // Never true: the step-2 declared-outcome check must miss, so the handler at step 3
          // is what actually names the outcome (section 5 §9.4's "backup for tenant text drift").
          ["never_true", txt("never_true", "This text never appears")],
        ]);
        const packConditions = new Map<string, Condition>([["limit_shown", txt("limit_shown", "Limit reached")]]);
        const handlers: Handler[] = [
          {
            class: "business_outcome",
            id: "sub_limit",
            description: "sub_limit",
            detector: "limit_shown",
            fixtures: { fire: [], no_fire: [] },
            outcome: { code: "sub_account_limit", description: "at the limit" },
          },
        ];
        const stepOutcomes: ContractOutcome[] = declared
          ? [{ code: "sub_account_limit", description: "at the limit", condition: "never_true" }]
          : [];
        const input: LadderInput = {
          stepId: "click_thing",
          stepIndex: 0,
          steps: [{ id: "click_thing", precondition: "start_shown", checkpoint: "done_shown", risk: "idempotent" }],
          floorIndex: 0,
          trouble: START,
          stepOutcomes,
          limits: { retriesUsedThisStep: 0, handlerAttemptsThisStep: {}, handlerAttemptsThisRun: 0, signInRunsUsed: 0, ladderEntriesUsed: 0, rewindsUsed: 0 },
          captureFiles: [],
        };
        const result = await runLadder(input, ladderDeps({ eyes, gate, log: () => undefined, taskConditions, packConditions, handlers }));
        if (declared) {
          expect(result).toMatchObject({ kind: "business_outcome", code: "sub_account_limit" });
        } else {
          expect(result).toMatchObject({ kind: "hard_failure", code: "undeclared_outcome", transient: false });
        }
      } finally {
        await close();
      }
    };
  }

  test("declared at this step: business_outcome", scenario(true));
  test("not declared at this step: failed undeclared_outcome, transient false", scenario(false));
});

describe("transport retry (section 7 §7.3, docs/decisions.md M06)", () => {
  test("an unregistered navigation recovers via retry.transport, first going to {system.last_good_path}", async () => {
    const site: FakeSite = {
      origin: ORIGIN,
      screens: { "/main": { elements: [{ id: "b", role: "generic", roleGroup: "container", text: "Start page" }] } },
    };
    // `/*` is policy-allowed, but `/broken` has no screen: the fake reports `browser_error_page`.
    const { eyes, gate, lines, close } = await open(site, ["/main", "/broken"], []);
    try {
      await gate.act({ actor: "engine", lease: LEASE, action: { type: "navigate", to: "/broken" }, step: "click_thing" });
      const taskConditions = new Map<string, Condition>([
        ["start_shown", loc("start_shown", "/main")],
        ["done_shown", loc("done_shown", "/done")],
      ]);
      const input: LadderInput = {
        stepId: "click_thing",
        stepIndex: 0,
        steps: [{ id: "click_thing", precondition: "start_shown", checkpoint: "done_shown", risk: "idempotent" }],
        floorIndex: 0,
        trouble: { ...START, transportEvent: "browser_error_page" },
        stepOutcomes: [],
        limits: { retriesUsedThisStep: 0, handlerAttemptsThisStep: {}, handlerAttemptsThisRun: 0, signInRunsUsed: 0, ladderEntriesUsed: 0, rewindsUsed: 0 },
        captureFiles: [],
      };
      // The retry's own navigate to `{system.last_good_path}` (here, "/main") runs as `engine`,
      // through the same gate every action crosses; it lands in the gate's own log, not the
      // ladder's `deps.log` (section 5 §8.5).
      const before = lines.length;
      const result = await runLadder(input, ladderDeps({ eyes, gate, log: () => undefined, taskConditions, lastGoodPath: "/main" }));
      expect(result).toMatchObject({ kind: "recovered", recovery: { via: "retry", ref: "retry.transport" } });
      const engineNav = lines
        .slice(before)
        .filter((l) => l.data.actor === "engine" && l.data.action === "navigate");
      expect(engineNav.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  test("a handler matching the error page still goes first, ahead of the transport retry", async () => {
    // The site never registers `/broken`: the fake's own `browser_error_page` page carries no
    // app text, so the handler's detector matches on location alone (section 7 §7.3, "no app
    // text to detect").
    const site: FakeSite = { origin: ORIGIN, screens: { "/main": { elements: [] } } };
    const { eyes, gate, close } = await open(site, ["/main", "/broken"], ["/main"]);
    try {
      await gate.act({ actor: "engine", lease: LEASE, action: { type: "navigate", to: "/broken" }, step: "click_thing" });
      const taskConditions = new Map<string, Condition>([
        ["start_shown", loc("start_shown", "/main")],
        ["done_shown", loc("done_shown", "/done")],
      ]);
      const packConditions = new Map<string, Condition>([["broken_page", loc("broken_page", "/broken")]]);
      const handlers: Handler[] = [
        {
          class: "recoverable",
          id: "known_broken_page",
          description: "known_broken_page",
          detector: "broken_page",
          fixtures: { fire: [], no_fire: [] },
          response: [{ type: "navigate", location: "/main", risk: "idempotent" }],
          limits: { per_step: 3, per_run: 6 },
          on_exhausted: { class: "hard_failure", failure: "app_error" },
        },
      ];
      const input: LadderInput = {
        stepId: "click_thing",
        stepIndex: 0,
        steps: [{ id: "click_thing", precondition: "start_shown", checkpoint: "done_shown", risk: "idempotent" }],
        floorIndex: 0,
        trouble: { ...START, transportEvent: "browser_error_page" },
        stepOutcomes: [],
        limits: { retriesUsedThisStep: 0, handlerAttemptsThisStep: {}, handlerAttemptsThisRun: 0, signInRunsUsed: 0, ladderEntriesUsed: 0, rewindsUsed: 0 },
        captureFiles: [],
      };
      const result = await runLadder(input, ladderDeps({ eyes, gate, log: () => undefined, taskConditions, packConditions, handlers, lastGoodPath: "/main" }));
      expect(result).toMatchObject({ kind: "recovered", recovery: { via: "handler", ref: "known_broken_page" } });
    } finally {
      await close();
    }
  });
});

describe("the bank's blank, hang, unavailable, and logout faults (section 5 §14, docs/decisions.md M06)", () => {
  test("blank: the global blank_page handler recovers by going back to the last good page", async () => {
    const site: FakeSite = {
      origin: ORIGIN,
      screens: { "/main": { elements: [{ id: "b", role: "generic", roleGroup: "container", text: "This page is blank" }] } },
    };
    const { eyes, gate, close } = await open(site, ["/main"], ["/main"]);
    try {
      const taskConditions = new Map<string, Condition>([
        ["start_shown", loc("start_shown", "/main")],
        ["done_shown", loc("done_shown", "/done")],
      ]);
      const packConditions = new Map<string, Condition>([["blank_shown", txt("blank_shown", "This page is blank")]]);
      const handlers: Handler[] = [
        {
          class: "recoverable",
          id: "blank_page",
          description: "blank_page",
          detector: "blank_shown",
          fixtures: { fire: [], no_fire: [] },
          response: [{ type: "navigate", location: "/main", risk: "idempotent" }],
          limits: { per_step: 3, per_run: 6 },
          on_exhausted: { class: "hard_failure", failure: "app_error" },
        },
      ];
      const input: LadderInput = {
        stepId: "click_thing",
        stepIndex: 0,
        steps: [{ id: "click_thing", precondition: "start_shown", checkpoint: "done_shown", risk: "idempotent" }],
        floorIndex: 0,
        trouble: START,
        stepOutcomes: [],
        limits: { retriesUsedThisStep: 0, handlerAttemptsThisStep: {}, handlerAttemptsThisRun: 0, signInRunsUsed: 0, ladderEntriesUsed: 0, rewindsUsed: 0 },
        captureFiles: [],
      };
      const result = await runLadder(input, ladderDeps({ eyes, gate, log: () => undefined, taskConditions, packConditions, handlers }));
      expect(result).toMatchObject({ kind: "recovered", recovery: { via: "handler", ref: "blank_page" } });
    } finally {
      await close();
    }
  });

  test("unavailable: the global service_unavailable handler recovers the same way", async () => {
    const site: FakeSite = {
      origin: ORIGIN,
      screens: { "/main": { elements: [{ id: "b", role: "generic", roleGroup: "container", text: "Service Temporarily Unavailable" }] } },
    };
    const { eyes, gate, close } = await open(site, ["/main"], ["/main"]);
    try {
      const taskConditions = new Map<string, Condition>([
        ["start_shown", loc("start_shown", "/main")],
        ["done_shown", loc("done_shown", "/done")],
      ]);
      const packConditions = new Map<string, Condition>([["unavailable_shown", txt("unavailable_shown", "Service Temporarily Unavailable")]]);
      const handlers: Handler[] = [
        {
          class: "recoverable",
          id: "service_unavailable",
          description: "service_unavailable",
          detector: "unavailable_shown",
          fixtures: { fire: [], no_fire: [] },
          response: [{ type: "navigate", location: "/main", risk: "idempotent" }],
          limits: { per_step: 3, per_run: 6 },
          on_exhausted: { class: "hard_failure", failure: "app_error" },
        },
      ];
      const input: LadderInput = {
        stepId: "click_thing",
        stepIndex: 0,
        steps: [{ id: "click_thing", precondition: "start_shown", checkpoint: "done_shown", risk: "idempotent" }],
        floorIndex: 0,
        trouble: START,
        stepOutcomes: [],
        limits: { retriesUsedThisStep: 0, handlerAttemptsThisStep: {}, handlerAttemptsThisRun: 0, signInRunsUsed: 0, ladderEntriesUsed: 0, rewindsUsed: 0 },
        captureFiles: [],
      };
      const result = await runLadder(input, ladderDeps({ eyes, gate, log: () => undefined, taskConditions, packConditions, handlers }));
      expect(result).toMatchObject({ kind: "recovered", recovery: { via: "handler", ref: "service_unavailable" } });
    } finally {
      await close();
    }
  });

  test("hang: no handler names it; the checkpoint timeout retries and recovers", async () => {
    const site: FakeSite = { origin: ORIGIN, screens: { "/main": { elements: [] } } };
    const { eyes, gate, close } = await open(site, ["/main"], []);
    try {
      const taskConditions = new Map<string, Condition>([
        ["start_shown", loc("start_shown", "/main")],
        ["done_shown", loc("done_shown", "/done")],
      ]);
      const input: LadderInput = {
        stepId: "click_thing",
        stepIndex: 0,
        steps: [{ id: "click_thing", precondition: "start_shown", checkpoint: "done_shown", risk: "idempotent" }],
        floorIndex: 0,
        trouble: { ...START, transportEvent: "connection_closed" },
        stepOutcomes: [],
        limits: { retriesUsedThisStep: 0, handlerAttemptsThisStep: {}, handlerAttemptsThisRun: 0, signInRunsUsed: 0, ladderEntriesUsed: 0, rewindsUsed: 0 },
        captureFiles: [],
      };
      const result = await runLadder(input, ladderDeps({ eyes, gate, log: () => undefined, taskConditions, lastGoodPath: "/main" }));
      expect(result).toMatchObject({ kind: "recovered", recovery: { via: "retry", ref: "retry.transport" } });
    } finally {
      await close();
    }
  });

  test("logout: a sign_in handler recovers by re-running the prelude", async () => {
    const site: FakeSite = {
      origin: ORIGIN,
      screens: { "/main": { elements: [{ id: "b", role: "generic", roleGroup: "container", text: "You have been logged out" }] } },
    };
    const { eyes, gate, close } = await open(site, ["/main"], []);
    try {
      const taskConditions = new Map<string, Condition>([
        ["start_shown", loc("start_shown", "/main")],
        ["done_shown", loc("done_shown", "/done")],
      ]);
      const packConditions = new Map<string, Condition>([["logged_out", txt("logged_out", "You have been logged out")]]);
      const handlers: Handler[] = [
        {
          class: "recoverable",
          id: "back_at_login",
          description: "back_at_login",
          detector: "logged_out",
          fixtures: { fire: [], no_fire: [] },
          response: [{ type: "sign_in", risk: "idempotent" }],
          limits: { per_step: 2, per_run: 2 },
          on_exhausted: { class: "hard_failure", failure: "app_error" },
        },
      ];
      const input: LadderInput = {
        stepId: "click_thing",
        stepIndex: 0,
        steps: [{ id: "click_thing", precondition: "start_shown", checkpoint: "done_shown", risk: "idempotent" }],
        floorIndex: 0,
        trouble: START,
        stepOutcomes: [],
        limits: { retriesUsedThisStep: 0, handlerAttemptsThisStep: {}, handlerAttemptsThisRun: 0, signInRunsUsed: 0, ladderEntriesUsed: 0, rewindsUsed: 0 },
        captureFiles: [],
      };
      // A stub prelude: the point here is the ladder's own dispatch of `sign_in` and its resume,
      // not the prelude's own replay (covered by the full-run sign_in test).
      const result = await runLadder(
        input,
        ladderDeps({ eyes, gate, log: () => undefined, taskConditions, packConditions, handlers, runPrelude: () => Promise.resolve(true) }),
      );
      expect(result).toMatchObject({ kind: "recovered", recovery: { via: "handler", ref: "back_at_login" } });
    } finally {
      await close();
    }
  });
});
