// Proves the gate's picture check (design section 4 §7.8 check 4; section 7 §6.3): a confirmed
// flag on a control that now has no words stands when its picture matches the sealed crop at
// likeness 0.90 or more. A worse picture, a dropped crop, or no picture still blocks with
// `risk.live_mismatch`; a live control with other words is blocked as before. M08.
import { describe, expect, test } from "vitest";
import type { GateRun, Proposal } from "../../../src/core/safety/gate/gate.js";
import { decodePng, type Pixels } from "../../../src/core/targets/png.js";
import { encodePng } from "../../../src/fakes/png.js";
import { snapshotFactory, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import type { ElementRef } from "../../../src/ports/surface.js";
import {
  DISCOVERY,
  LEASE,
  gateConfig,
  openTestGate,
  testPolicy,
  type Opened,
} from "../../contract/surface/gate-kit.js";

const ORIGIN = "http://127.0.0.1:9182";
const policy = testPolicy({ allow: ["/"], deny: ["/__test__/*"], irreversible: [] });
const REPLAY: GateRun = { ...DISCOVERY, kind: "replay", declaredPaths: ["/"] };

/** A 20x10 picture: black left of 10, white after. `invert` swaps the colors. */
function half(invert = false): Pixels {
  const data = new Uint8Array(20 * 10 * 4);
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 20; x++) {
      const v = (x < 10) !== invert ? 0 : 255;
      data.set([v, v, v, 255], (y * 20 + x) * 4);
    }
  }
  return { w: 20, h: 10, data };
}

const SEALED = half();
const SAME = encodePng(SEALED);
const INVERSE = encodePng(half(true));
const box = (x: number) => ({ x, y: 100, width: 64, height: 24 });

const bare = (id: string, extra = {}) => ({
  id,
  role: "button",
  roleGroup: "button_like" as const,
  image: SAME,
  box: box(10),
  ...extra,
});

const site: FakeSite = {
  origin: ORIGIN,
  screens: {
    "/": {
      elements: [
        bare("same", { box: box(10) }),
        bare("inverse", { image: INVERSE, box: box(200) }),
        bare("nobox", { box: null }),
        bare("masked", { box: box(400) }),
        {
          id: "secret",
          role: "textbox",
          roleGroup: "text_entry" as const,
          label: "Note",
          field: { kind: "text" as const, filled: true as const },
          box: { x: 410, y: 105, width: 100, height: 20 },
        },
        bare("words", { name: "Confirm", text: "Confirm", box: box(600) }),
      ],
    },
  },
};

async function refOf(g: Opened, id: string): Promise<ElementRef> {
  const o = await g.eyes.observe();
  const found = o.ok ? o.value.elements.find((e) => e.clues.path.includes(`[${id}]`)) : undefined;
  if (found === undefined) throw new Error(`no element ${id}`);
  return found.ref;
}

const picture = ((): Pixels => {
  const px = decodePng(SAME);
  if (!px.ok) throw new Error("bad test picture");
  return px.value;
})();

async function decide(id: string, confirmed: Proposal["confirmed"]): Promise<string> {
  const g = await openTestGate(snapshotFactory(site), gateConfig(ORIGIN, policy), policy, REPLAY);
  const target = await refOf(g, id);
  const p: Proposal = {
    actor: "engine",
    lease: LEASE,
    action: { type: "click", target },
    step: null,
    ...(confirmed === undefined ? {} : { confirmed }),
  };
  const r = await g.gate.act(p);
  return r.ok ? `${r.value.decision} ${r.value.rule}` : r.failure;
}

const flag = { risk: "idempotent" as const, words: ["Search"] };

describe("gate check 4, picture match", () => {
  test("a wordless control that looks the same keeps the flag", async () => {
    expect(await decide("same", { ...flag, picture })).toBe("allowed risk.allowed");
  });

  test("a different picture (likeness under 0.90) blocks", async () => {
    expect(await decide("inverse", { ...flag, picture })).toBe("blocked risk.live_mismatch");
  });

  test("a dropped live crop blocks: no box, or a mask box touches it", async () => {
    expect(await decide("nobox", { ...flag, picture })).toBe("blocked risk.live_mismatch");
    expect(await decide("masked", { ...flag, picture })).toBe("blocked risk.live_mismatch");
  });

  test("no recorded picture blocks", async () => {
    expect(await decide("same", flag)).toBe("blocked risk.live_mismatch");
  });

  test("live words that class stricter still block, even with a matching picture", async () => {
    expect(await decide("words", { ...flag, picture })).toBe("blocked risk.live_mismatch");
  });
});
