// Proves the gate reads the real lease: a stale token is blocked `lease.not_holder`, the current
// bot token is allowed, and a human-actor proposal is observed whoever holds the lease.
// Design section 7 §12.3; section 4 §3.3 (check 1) and §7.10. M07 task 1.
import { describe, expect, test } from "vitest";
import { Lease } from "../../../src/core/handoff/lease.js";
import { openGate, type GateLine } from "../../../src/core/safety/gate/gate.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { SeededIds } from "../../../src/fakes/ids.js";
import { snapshotFactory, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import type { ElementRef, LeaseToken } from "../../../src/ports/surface.js";
import { DISCOVERY, gateConfig, testDeps, testPolicy } from "../../contract/surface/gate-kit.js";
import type { Actor } from "../../../src/core/safety/rules.js";

const ORIGIN = "http://127.0.0.1:9182";
const policy = testPolicy({ allow: ["/"], deny: ["/__test__/*"], irreversible: [] });
const site: FakeSite = {
  origin: ORIGIN,
  screens: {
    "/": {
      elements: [{ id: "search", role: "button", roleGroup: "button_like", name: "Search", text: "Search" }],
    },
  },
};

/** A gate whose lease check reads a real `Lease`. */
async function setup(): Promise<{
  lease: Lease;
  press: (actor: Actor, token: LeaseToken) => Promise<string>;
}> {
  const lease = new Lease(new SeededIds(new SteppingClock(), 5), () => undefined);
  lease.start();
  const lines: GateLine[] = [];
  const opened = await openGate(snapshotFactory(site), gateConfig(ORIGIN, policy), {
    ...testDeps(policy, DISCOVERY, lines),
    lease: () => lease.current(),
  });
  if (!opened.ok) throw new Error(`open failed: ${opened.failure}`);
  const { eyes, gate } = opened.value;
  const obs = await eyes.observe();
  if (!obs.ok) throw new Error("observe failed");
  const target: ElementRef | undefined = obs.value.elements.find((e) => e.clues.name === "Search")?.ref;
  if (target === undefined) throw new Error("no Search button");
  return {
    lease,
    press: async (actor, token) => {
      const r = await gate.act({ actor, lease: token, action: { type: "click", target }, step: null });
      return r.ok ? `${r.value.decision} ${r.value.rule}` : r.failure;
    },
  };
}

describe("the gate and the lease (section 4 §3.3, section 7 §12.3)", () => {
  test("the current bot token is allowed", async () => {
    const { lease, press } = await setup();
    expect(await press("llm", lease.botToken())).toBe("allowed risk.allowed");
  });

  test("after a takeover the old token is blocked lease.not_holder, even once the bot holds again", async () => {
    const { lease, press } = await setup();
    const stale = lease.botToken();
    lease.requestTakeover();
    expect(await press("llm", stale)).toBe("blocked lease.not_holder");

    lease.claim("op_1");
    lease.handBack();
    lease.reverified();
    expect(await press("llm", stale)).toBe("blocked lease.not_holder");
    expect(await press("llm", lease.botToken())).toBe("allowed risk.allowed");
  });

  test("while a human or nobody holds it, even the newest bot token is blocked", async () => {
    const { lease, press } = await setup();
    lease.requestTakeover();
    expect(await press("llm", lease.botToken())).toBe("blocked lease.not_holder");
    lease.claim("op_1");
    expect(await press("llm", lease.botToken())).toBe("blocked lease.not_holder");
  });

  test("a human-actor proposal is observed, never gated by the lease (section 4 §7.10)", async () => {
    const { lease, press } = await setup();
    const stale = lease.botToken();
    lease.requestTakeover();
    lease.claim("op_1");
    expect(await press("human", stale)).toBe("observed human.observed");
  });
});
