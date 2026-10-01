// Proves the planner cassette round trip on the snapshot surface: a run through the real Claude
// adapter (over a fake HTTP layer) is saved as a cassette; the cassette replays it with no model;
// a changed observation stops the replay loudly. Design section 9 §16 ("Planner cassette"); M03
// tasks 12 and 13. The live replay on the bank app is tests/live/cassette.test.ts.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ClaudePlanner } from "../../../src/adapters/claude/planner.js";
import { CassettePlanner } from "../../../src/fakes/cassette-planner.js";
import type { FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { cassetteOf } from "../../../scripts/cassette.js";
import { RunSpec } from "../../../src/core/model/runspec.js";
import { run, SIGN_IN, SIGN_IN_STEPS, SITE, type Ran } from "./run-kit.js";

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

describe("the cassette's prompt label (section 6 §11.4: versions are frozen per run)", () => {
  /** Records a run of the sign-in spec on `prompt`, and returns its folder and ID. */
  async function recorded(prompt: string) {
    const r = await run({ planner: claude(), spec: RunSpec.parse({ ...SIGN_IN, prompt }) });
    done.push(r);
    expect(r.result.status).toBe("success");
    return { dir: join(r.root, "evidence", "keystone", "runs", r.result.runId), id: r.result.runId };
  }

  test.each(["discovery@1.0", "discovery@1.1"])(
    "with no argument, a %s run is labelled with its own version",
    async (prompt) => {
      const { dir, id } = await recorded(prompt);
      expect(cassetteOf(dir, id).prompt).toBe(prompt);
    },
  );

  test("an explicit argument wins over the run's version", async () => {
    const { dir, id } = await recorded("discovery@1.1");
    expect(cassetteOf(dir, id, "discovery@1.0").prompt).toBe("discovery@1.0");
  });

  test("a run_start with no prompt version throws", async () => {
    const { dir, id } = await recorded("discovery@1.0");
    const tmp = mkdtempSync(join(tmpdir(), "intyy-cassette-"));
    try {
      cpSync(dir, tmp, { recursive: true });
      const lines = readFileSync(join(tmp, "events.jsonl"), "utf8").split("\n");
      const start = JSON.parse(lines[0] ?? "") as { data: { frozen: { models: Record<string, unknown> } } };
      delete start.data.frozen.models.prompt;
      lines[0] = JSON.stringify(start);
      writeFileSync(join(tmp, "events.jsonl"), lines.join("\n"));
      expect(() => cassetteOf(tmp, id)).toThrow("run_start records no prompt version");
      // An explicit argument needs no recorded version.
      expect(cassetteOf(tmp, id, "discovery@1.0").prompt).toBe("discovery@1.0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
