// Proves the gate: the matrix of actor × class × run kind, and each rule in the check order.
// Design section 4 §3.3 to §3.6, §6.9, §7.8 to §7.10; section 4 §14, "Gate matrix"; M02 task 7.
import { describe, expect, test } from "vitest";
import type { GateAction, GateRun, Proposal } from "../../../src/core/safety/gate/gate.js";
import type { RiskClass } from "../../../src/core/safety/risk/classify.js";
import type { Actor } from "../../../src/core/safety/rules.js";
import { snapshotFactory, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import type { ElementRef, Eyes } from "../../../src/ports/surface.js";
import {
  DISCOVERY,
  LEASE,
  gateConfig,
  openTestGate,
  testPolicy,
  type Opened,
} from "../../contract/surface/gate-kit.js";

const ORIGIN = "http://127.0.0.1:9181";

const policy = testPolicy({
  allow: ["/", "/other", "/accounts/*/close", "/declared"],
  deny: ["/__test__/*"],
  irreversible: ["/accounts/*/close"],
});

const button = (id: string, name: string, extra = {}) => ({
  id,
  role: "button",
  roleGroup: "button_like" as const,
  name,
  text: name,
  ...extra,
});

const site: FakeSite = {
  origin: ORIGIN,
  screens: {
    "/": {
      elements: [
        button("search", "Search"),
        button("add", "Add Row"),
        button("confirm", "Confirm"),
        button("ok", "OK"),
        button("ask", "Rename", { onClick: { dialog: { kind: "prompt", message: "New name?" } } }),
        button("export", "Export", { onClick: { download: true } }),
        {
          id: "amount",
          role: "textbox",
          roleGroup: "text_entry" as const,
          label: "Amount",
          field: { kind: "text" as const, value: "" },
          form: { id: "dep", submits: false },
        },
        button("next", "Next", { form: { id: "dep", submits: true } }),
        {
          id: "note",
          role: "textbox",
          roleGroup: "text_entry" as const,
          label: "Note",
          field: { kind: "text" as const, value: "" },
        },
      ],
    },
    "/other": { elements: [] },
    "/declared": { elements: [] },
  },
};

const REPLAY: GateRun = { ...DISCOVERY, kind: "replay", declaredPaths: ["/", "/declared"] };
const READ_ONLY: GateRun = { ...REPLAY, readOnly: true };

/** Opens a fresh gate on the fake. */
const open = (run: GateRun = DISCOVERY): Promise<Opened> =>
  openTestGate(snapshotFactory(site), gateConfig(ORIGIN, policy), policy, run);

/** The ref of the element with this name. */
async function refOf(eyes: Eyes, name: string): Promise<ElementRef> {
  const o = await eyes.observe();
  const el = o.ok
    ? o.value.elements.find((e) => e.clues.name === name || e.clues.label === name)
    : undefined;
  if (el === undefined) throw new Error(`no element ${name}`);
  return el.ref;
}

/** A proposal with the test lease. */
const propose = (actor: Actor, action: GateAction, extra: Partial<Proposal> = {}): Proposal => ({
  actor,
  lease: LEASE,
  action,
  step: null,
  ...extra,
});

/** Proposes and returns "decision rule". */
async function decide(g: Opened, p: Proposal): Promise<string> {
  const r = await g.gate.act(p);
  if (!r.ok) return r.failure;
  return `${r.value.decision} ${r.value.rule}`;
}

describe("gate matrix: actor × class × run kind (section 4 §14)", () => {
  const classes: [label: string, name: string, confirmed: RiskClass][] = [
    ["idempotent", "Search", "idempotent"],
    ["reversible", "Add Row", "reversible"],
    ["irreversible", "Confirm", "irreversible"],
    ["unsure", "OK", "irreversible"],
  ];
  const A = "allowed risk.allowed";
  const ACTION = "blocked allowlist.action";
  const ACTOR = "blocked risk.actor";
  const NEEDS = "needs_approval risk.needs_approval";
  const OBS = "observed human.observed";
  const RO = "blocked risk.read_only_run";
  const expected: Record<string, Record<Actor, string[]>> = {
    discovery: {
      engine: [ACTION, ACTION, ACTION, ACTION],
      handler: [A, A, ACTOR, ACTOR],
      llm: [A, A, NEEDS, "needs_approval risk.unsure"],
      reviewer: [ACTION, ACTION, ACTION, ACTION],
      human: [OBS, OBS, OBS, OBS],
    },
    replay: {
      engine: [A, A, NEEDS, NEEDS],
      handler: [A, A, ACTOR, ACTOR],
      llm: [ACTION, ACTION, ACTION, ACTION],
      reviewer: [A, ACTOR, ACTOR, ACTOR],
      human: [OBS, OBS, OBS, OBS],
    },
    read_only: {
      engine: [A, A, RO, RO],
      handler: [A, A, ACTOR, ACTOR],
      llm: [ACTION, ACTION, ACTION, ACTION],
      reviewer: [A, ACTOR, ACTOR, ACTOR],
      human: [OBS, OBS, OBS, OBS],
    },
  };
  const runs: Record<string, GateRun> = {
    discovery: DISCOVERY,
    replay: REPLAY,
    read_only: READ_ONLY,
  };

  for (const [runName, byActor] of Object.entries(expected)) {
    for (const [actor, answers] of Object.entries(byActor) as [Actor, string[]][]) {
      for (const [i, [cls, name, confirmed]] of classes.entries()) {
        const want = answers[i] ?? "";
        test(`${runName} · ${actor} · ${cls}: ${want}`, async () => {
          const g = await open(runs[runName]);
          const target = await refOf(g.eyes, name);
          // Why: engine steps and handler actions carry a human-confirmed flag (section 4 §7.8, §7.9).
          const flag =
            actor === "engine" || actor === "handler"
              ? { confirmed: { risk: confirmed, words: [name] } }
              : {};
          expect(await decide(g, propose(actor, { type: "click", target }, flag))).toBe(want);
          await g.gate.close();
        });
      }
    }
  }
});

describe("check order and rules", () => {
  test("a wrong lease is blocked first (section 4 §3.3, check 1)", async () => {
    const g = await open();
    const target = await refOf(g.eyes, "Confirm");
    const other = "lease-other" as unknown as typeof LEASE;
    expect(await decide(g, { ...propose("llm", { type: "click", target }), lease: other })).toBe(
      "blocked lease.not_holder",
    );
  });

  test("a block names what it means for each actor (section 4 §3.5)", async () => {
    const g = await open(REPLAY);
    const target = await refOf(g.eyes, "Confirm");
    const r = await g.gate.act(propose("reviewer", { type: "click", target }));
    expect(r.ok && r.value.onBlock).toBe("takeover_unsafe_state");
    const e = await g.gate.act(
      propose(
        "engine",
        { type: "navigate", to: "/admin" },
        { confirmed: { risk: "idempotent", words: [] } },
      ),
    );
    expect(e.ok && e.value.onBlock).toBe("action_blocked");
  });

  test("pages: off the list, another host, and an irreversible path", async () => {
    const g = await open();
    expect(await decide(g, propose("llm", { type: "navigate", to: "/admin" }))).toBe(
      "blocked allowlist.path",
    );
    expect(await decide(g, propose("llm", { type: "navigate", to: "/__test__/faultlog" }))).toBe(
      "blocked allowlist.path",
    );
    expect(await decide(g, propose("llm", { type: "navigate", to: "https://www.ncua.gov/" }))).toBe(
      "blocked allowlist.host",
    );
    expect(await decide(g, propose("llm", { type: "navigate", to: "/members/1%2F2" }))).toBe(
      "blocked allowlist.path_malformed",
    );
    expect(await decide(g, propose("llm", { type: "navigate", to: "/accounts/9/close" }))).toBe(
      "needs_approval risk.needs_approval",
    );
  });

  test("a helper navigates only inside runs_on.paths (helper.path)", async () => {
    const g = await open(REPLAY);
    const flag = { confirmed: { risk: "idempotent" as const, words: [] } };
    expect(await decide(g, propose("handler", { type: "navigate", to: "/other" }, flag))).toBe(
      "blocked helper.path",
    );
    expect(await decide(g, propose("handler", { type: "navigate", to: "/declared" }, flag))).toBe(
      "allowed risk.allowed",
    );
  });

  test("keys: an unmapped function key is blocked; a mapped one is classed by its label", async () => {
    const g = await open();
    expect(await decide(g, propose("llm", { type: "press", key: "F10", target: null }))).toBe(
      "blocked allowlist.key",
    );
    expect(await decide(g, propose("llm", { type: "press", key: "F2", target: null }))).toBe(
      "allowed risk.allowed",
    );
  });

  test("values: a mask token is never typed; helpers type only what §6.9 allows", async () => {
    const g = await open(REPLAY);
    const target = await refOf(g.eyes, "Note");
    const text = (t: string) => ({ kind: "text" as const, text: t });
    const input = {
      kind: "input" as const,
      ref: "input.note",
      text: "hello",
      label: "none" as const,
    };
    const flag = { confirmed: { risk: "idempotent" as const, words: [] } };
    expect(
      await decide(g, propose("engine", { type: "type", target, value: text("[name#1]") }, flag)),
    ).toBe("blocked value.mask_token");
    expect(
      await decide(
        g,
        propose("engine", { type: "type", target, value: text("{input.member_id}") }, flag),
      ),
    ).toBe("blocked value.mask_token");
    expect(
      await decide(g, propose("reviewer", { type: "type", target, value: text("free") })),
    ).toBe("blocked allowlist.action");
    expect(await decide(g, propose("handler", { type: "type", target, value: input }, flag))).toBe(
      "blocked allowlist.action",
    );
    expect(await decide(g, propose("reviewer", { type: "type", target, value: input }))).toBe(
      "allowed risk.allowed",
    );
  });

  test("C1: Enter in a form holding a financial input is irreversible", async () => {
    const g = await open();
    const target = await refOf(g.eyes, "Amount");
    const deposit = {
      kind: "input" as const,
      ref: "input.deposit",
      text: "137.00",
      label: "financial" as const,
    };
    expect(await decide(g, propose("llm", { type: "type", target, value: deposit }))).toBe(
      "allowed risk.allowed",
    );
    const again = await refOf(g.eyes, "Amount");
    expect(await decide(g, propose("llm", { type: "press", key: "Enter", target: again }))).toBe(
      "needs_approval risk.needs_approval",
    );
    const next = await refOf(g.eyes, "Next");
    expect(await decide(g, propose("llm", { type: "click", target: next }))).toBe(
      "needs_approval risk.needs_approval",
    );
  });

  test("Enter with no form is unsure", async () => {
    const g = await open();
    const target = await refOf(g.eyes, "Note");
    expect(await decide(g, propose("llm", { type: "press", key: "Enter", target }))).toBe(
      "needs_approval risk.unsure",
    );
  });

  test("a human yes allows one irreversible action", async () => {
    const g = await open();
    const target = await refOf(g.eyes, "OK");
    const r = await g.gate.act(
      propose("llm", { type: "click", target }, { approval: { by: "op_022" } }),
    );
    expect(r.ok && [r.value.decision, r.value.rule, r.value.act?.dispatched]).toEqual([
      "allowed",
      "risk.human_approved",
      true,
    ]);
  });

  describe("replay checks (section 4 §7.8)", () => {
    const flag = { confirmed: { risk: "irreversible" as const, words: ["Confirm"] } };

    test("check 1: the commit point with a valid authorization is allowed", async () => {
      const g = await open({ ...REPLAY, authorizationValid: () => true });
      const target = await refOf(g.eyes, "Confirm");
      expect(
        await decide(
          g,
          propose("engine", { type: "click", target }, { ...flag, commitPoint: true }),
        ),
      ).toBe("allowed risk.authorized");
    });

    test("check 1: no authorization, or force_human, pauses for a human", async () => {
      const g = await open(REPLAY);
      const target = await refOf(g.eyes, "Confirm");
      expect(
        await decide(
          g,
          propose("engine", { type: "click", target }, { ...flag, commitPoint: true }),
        ),
      ).toBe("needs_approval risk.needs_approval");
      const forced = await open({ ...REPLAY, authorizationValid: () => true, forceHuman: true });
      const t2 = await refOf(forced.eyes, "Confirm");
      expect(
        await decide(
          forced,
          propose("engine", { type: "click", target: t2 }, { ...flag, commitPoint: true }),
        ),
      ).toBe("needs_approval risk.needs_approval");
    });

    test("check 1: an irreversible step that is not the commit point pauses", async () => {
      const g = await open({ ...REPLAY, authorizationValid: () => true });
      const target = await refOf(g.eyes, "Confirm");
      expect(await decide(g, propose("engine", { type: "click", target }, flag))).toBe(
        "needs_approval risk.needs_approval",
      );
    });

    test("check 3: after the commit is sent, a second irreversible action is blocked", async () => {
      const g = await open({ ...REPLAY, authorizationValid: () => true });
      const target = await refOf(g.eyes, "Confirm");
      await decide(g, propose("engine", { type: "click", target }, { ...flag, commitPoint: true }));
      const again = await refOf(g.eyes, "Confirm");
      expect(
        await decide(
          g,
          propose(
            "engine",
            { type: "click", target: again },
            { ...flag, approval: { by: "op_022" } },
          ),
        ),
      ).toBe("blocked risk.second_commit");
    });

    test("check 3 is for replay only: discovery asks a human each time", async () => {
      const g = await open();
      const confirm = await refOf(g.eyes, "Confirm");
      const yes = { approval: { by: "op_022" } };
      expect(await decide(g, propose("llm", { type: "click", target: confirm }, yes))).toBe(
        "allowed risk.human_approved",
      );
      const again = await refOf(g.eyes, "Confirm");
      expect(await decide(g, propose("llm", { type: "click", target: again }, yes))).toBe(
        "allowed risk.human_approved",
      );
    });

    test("check 4: live words that class stricter than the flag are blocked", async () => {
      const g = await open(REPLAY);
      const target = await refOf(g.eyes, "Confirm");
      const lowered = { confirmed: { risk: "idempotent" as const, words: ["Search"] } };
      expect(await decide(g, propose("engine", { type: "click", target }, lowered))).toBe(
        "blocked risk.live_mismatch",
      );
    });

    test("check 4: the same words keep the human's lowered flag", async () => {
      const g = await open(REPLAY);
      const target = await refOf(g.eyes, "Confirm");
      const lowered = { confirmed: { risk: "idempotent" as const, words: ["confirm"] } };
      expect(await decide(g, propose("engine", { type: "click", target }, lowered))).toBe(
        "allowed risk.allowed",
      );
    });

    test("check 4: different words that are not stricter keep the flag", async () => {
      const g = await open(REPLAY);
      const target = await refOf(g.eyes, "Search");
      const strict = { confirmed: { risk: "irreversible" as const, words: ["Submit"] } };
      expect(await decide(g, propose("engine", { type: "click", target }, strict))).toBe(
        "needs_approval risk.needs_approval",
      );
    });
  });

  test("no helper acts while a non-idempotent action is in flight (risk.in_flight)", async () => {
    const g = await open(REPLAY);
    const add = await refOf(g.eyes, "Add Row");
    const reversible = { confirmed: { risk: "reversible" as const, words: ["Add Row"] } };
    expect(await decide(g, propose("engine", { type: "click", target: add }, reversible))).toBe(
      "allowed risk.allowed",
    );
    const search = await refOf(g.eyes, "Search");
    expect(await decide(g, propose("reviewer", { type: "click", target: search }))).toBe(
      "blocked risk.in_flight",
    );
    g.gate.settled();
    expect(await decide(g, propose("reviewer", { type: "click", target: search }))).toBe(
      "allowed risk.allowed",
    );
  });

  test("a native prompt box goes to a human (browser.prompt)", async () => {
    const g = await open();
    const ask = await refOf(g.eyes, "Rename");
    await g.gate.act(
      propose("llm", { type: "click", target: ask }, { approval: { by: "op_022" } }),
    );
    const accept = await refOf(g.eyes, "OK");
    expect(
      await decide(
        g,
        propose("llm", { type: "click", target: accept }, { approval: { by: "op_022" } }),
      ),
    ).toBe("blocked browser.prompt");
  });

  test("a stale ref is an expected failure, not a decision", async () => {
    const g = await open();
    const target = await refOf(g.eyes, "Search");
    await g.gate.act(propose("llm", { type: "navigate", to: "/other" }));
    expect(await decide(g, propose("llm", { type: "click", target }))).toBe("stale_element");
  });

  test("gate lines name the rule, and mask the label and path (section 4 §3.7)", async () => {
    const g = await open();
    const target = await refOf(g.eyes, "OK");
    await g.gate.act(propose("llm", { type: "click", target }));
    expect(g.lines.at(-1)).toEqual({
      event: "gate",
      step: null,
      by: "gate",
      why: { kind: "policy", ref: "risk.unsure" },
      data: {
        actor: "llm",
        action: "click",
        decision: "needs_approval",
        risk: "irreversible",
        label: "OK",
        path: "/",
      },
    });
  });

  test("a download is blocked and logged as browser.download", async () => {
    const g = await open();
    const target = await refOf(g.eyes, "Export");
    await g.gate.act(propose("llm", { type: "click", target }, { approval: { by: "op_022" } }));
    await new Promise((r) => setImmediate(r));
    expect(g.lines.at(-1)).toMatchObject({
      why: { ref: "browser.download" },
      data: { actor: "llm", action: "download", decision: "blocked" },
    });
  });
});

// M05 task 11: the discovery prelude window (section 6 §5.5, section 7 §10;
// docs/decisions.md, M05: "engine is allowed only until a one-way endPrelude()").
describe("the discovery prelude window (section 6 §5.5, section 7 §10)", () => {
  const NAV = { type: "navigate", to: "/" } as const;

  test("engine is blocked before beginPrelude, allowed inside it, and blocked again after", async () => {
    const g = await open();
    expect(await decide(g, propose("engine", NAV))).toBe("blocked allowlist.action");
    g.gate.beginPrelude();
    expect(await decide(g, propose("engine", NAV))).toBe("allowed risk.allowed");
    g.gate.endPrelude();
    expect(await decide(g, propose("engine", NAV))).toBe("blocked allowlist.action");
  });

  test("beginPrelude called twice throws (only a bug calls it twice)", async () => {
    const g = await open();
    g.gate.beginPrelude();
    expect(() => {
      g.gate.beginPrelude();
    }).toThrow();
  });

  test("beginPrelude after any non-engine actor has acted throws (only a bug opens it late)", async () => {
    const g = await open();
    await g.gate.act(propose("llm", NAV));
    expect(() => {
      g.gate.beginPrelude();
    }).toThrow();
  });
});
