// Proves discovery's own prelude (section 6 §5.5, section 7 §10; docs/decisions.md, M05 task
// 11): a resolvable `session` link runs the sealed session artifact's steps first, logged
// `session:<id>`, then navigates to `spec.entry`, then the LLM loop starts there at turn 1. The
// planner never sees the prelude's own screens.
import { afterEach, describe, expect, test } from "vitest";
import { ScriptedPlanner } from "../../../src/fakes/scripted-planner.js";
import type { FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { run, SITE, type Ran } from "./run-kit.js";
import { LINKED_SPEC, SESSION_ARTIFACT } from "./session-kit.js";

const done: Ran[] = [];
afterEach(async () => {
  for (const r of done.splice(0)) await r.remove();
});

/** Runs and remembers the temp folder for clean-up. */
async function go(opts: Parameters<typeof run>[0]): Promise<Ran> {
  const r = await run(opts);
  done.push(r);
  return r;
}

describe("the discovery prelude (section 6 §5.5, section 7 §10)", () => {
  test("runs the session artifact first, then the loop starts on spec.entry with no second navigate", async () => {
    const planner = new ScriptedPlanner([{ name: "done", input: { summary: "On the home page.", proof: ["e1"] } }]);
    const r = await go({ spec: LINKED_SPEC, sealedSession: SESSION_ARTIFACT, planner, site: SITE });

    expect(r.result).toMatchObject({ status: "success", code: null });

    // The prelude's own gate lines: navigate to the session's entry, then its one step.
    const gateSteps = r.events.filter((e) => e.event === "gate").map((e) => e.step);
    expect(gateSteps).toContain("session:entry");
    expect(gateSteps).toContain("session:click_login");
    // The prelude's click already landed on spec.entry (`/home`), so the engine does not
    // navigate there again: a reload of a frameset shows an empty screen (docs/decisions.md, M05).
    expect(gateSteps).not.toContain("entry");

    // No llm_decision or action line belongs to the prelude: only the loop's one turn shows up.
    expect(r.events.filter((e) => e.event === "llm_decision")).toHaveLength(1);
    expect(r.events.filter((e) => e.event === "action")).toHaveLength(0);
    expect(r.events.filter((e) => e.event === "observation")).toHaveLength(1);

    // The planner never saw the prelude's own "/" sign-in screen: its one turn is already at
    // spec.entry.
    const seen = planner.seen;
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toContain('<screen location="/home" title="Teller Workstation">');
    expect(seen[0]?.message).not.toContain('location="/"');
  });

  test("when the prelude ends somewhere else, the engine still navigates to spec.entry", async () => {
    // The session's click lands on `/home?from=login`: the same path as `/home`, but a different
    // place (path and query both count), so the entry navigate must still run.
    const start = SITE.screens["/"];
    if (start === undefined) throw new Error("SITE has no start screen");
    const site: FakeSite = {
      ...SITE,
      screens: {
        ...SITE.screens,
        "/": {
          ...start,
          elements: start.elements.map((e) => (e.id === "go" ? { ...e, onClick: { go: "/home?from=login" } } : e)),
        },
      },
    };
    const planner = new ScriptedPlanner([{ name: "done", input: { summary: "On the home page.", proof: ["e1"] } }]);
    const r = await go({ spec: LINKED_SPEC, sealedSession: SESSION_ARTIFACT, planner, site });

    expect(r.result).toMatchObject({ status: "success", code: null });
    const gateSteps = r.events.filter((e) => e.event === "gate").map((e) => e.step);
    expect(gateSteps).toContain("session:click_login");
    expect(gateSteps).toContain("entry");
    expect(gateSteps.indexOf("entry")).toBeGreaterThan(gateSteps.indexOf("session:click_login"));
  });
});
