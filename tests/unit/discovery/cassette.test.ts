// Proves the planner cassette round trip on the snapshot surface: a run through the real Claude
// adapter (over a fake HTTP layer) is saved as a cassette; the cassette replays it with no model;
// a changed observation stops the replay loudly. Design section 9 §16 ("Planner cassette"); M03
// tasks 12 and 13. The live replay on the bank app is tests/live/cassette.test.ts.
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ClaudePlanner } from "../../../src/adapters/claude/planner.js";
import { CassettePlanner } from "../../../src/fakes/cassette-planner.js";
import type { FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { cassetteOf } from "../../../scripts/cassette.js";
import { run, SIGN_IN_STEPS, SITE, type Ran } from "./run-kit.js";

const done: Ran[] = [];
afterEach(async () => {
  for (const r of done.splice(0)) await r.remove();
});

/** A Claude planner whose fake HTTP layer answers the sign-in steps in order. */
function claude(): ClaudePlanner {
  let i = 0;
  const f: typeof fetch = () => {
    const step = SIGN_IN_STEPS[i] as { name: string; input: unknown };
    i += 1;
    const body = {
      id: `msg_${String(i)}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "tool_use", id: `tu_${String(i)}`, name: step.name, input: step.input }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return new ClaudePlanner({ apiKey: "test-key", fetch: f, baseURL: "http://127.0.0.1:9" });
}

/** Records a run through the Claude adapter and returns its cassette. */
async function record() {
  const r = await run({ planner: claude() });
  done.push(r);
  expect(r.result.status).toBe("success");
  return cassetteOf(join(r.root, "evidence", "keystone", "runs", r.result.runId), r.result.runId);
}

describe("planner cassette", () => {
  test("a saved run replays to the same end with no model", async () => {
    const cassette = await record();
    expect(cassette.turns).toHaveLength(4);
    expect(cassette.turns[0]?.reply.call?.name).toBe("type");
    const planner = new CassettePlanner(cassette);
    const r = await run({ planner });
    done.push(r);
    expect(r.result.status).toBe("success");
    expect(planner.played).toBe(4);
  });

  test("a changed number, like a real login time, still replays", async () => {
    // Why: CONTRACT §7, some times follow the real clock, so digits may differ run to run.
    const home = SITE.screens["/"];
    if (home === undefined) throw new Error("SITE has no start page");
    const withTime = (t: string): FakeSite => ({
      ...SITE,
      screens: {
        ...SITE.screens,
        "/": {
          ...home,
          elements: [
            ...home.elements,
            { id: "clock", role: "generic", roleGroup: "container", text: `Last login ${t}` },
          ],
        },
      },
    });
    const r1 = await run({ planner: claude(), site: withTime("12:01:27") });
    done.push(r1);
    const c = cassetteOf(
      join(r1.root, "evidence", "keystone", "runs", r1.result.runId),
      r1.result.runId,
    );
    const r2 = await run({ planner: new CassettePlanner(c), site: withTime("12:38:58") });
    done.push(r2);
    expect(r2.result.status).toBe("success");
  });

  test("a changed observation stops the replay loudly", async () => {
    const cassette = await record();
    const root = SITE.screens["/"];
    if (root === undefined) throw new Error("SITE has no start page");
    const changed: FakeSite = {
      ...SITE,
      screens: {
        ...SITE.screens,
        "/": {
          ...root,
          elements: root.elements.map((e) => (e.id === "h" ? { ...e, text: "Staff Sign In" } : e)),
        },
      },
    };
    await expect(run({ planner: new CassettePlanner(cassette), site: changed })).rejects.toThrow(
      /turn 1 saw a changed observation, line \d+:\n {2}saved: e1 heading "Teller Sign In"\n {2}now: {3}e1 heading "Staff Sign In"/,
    );
  });
});
