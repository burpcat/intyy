// Proves discovery's own prelude (section 6 §5.5, section 7 §10; docs/decisions.md, M05 task
// 11): a resolvable `session` link runs the sealed session artifact's steps first, logged
// `session:<id>`, then navigates to `spec.entry`, then the LLM loop starts there at turn 1. The
// planner never sees the prelude's own screens.
import { afterEach, describe, expect, test } from "vitest";
import { Artifact } from "../../../src/core/model/artifact.js";
import { RunSpec } from "../../../src/core/model/runspec.js";
import { ScriptedPlanner } from "../../../src/fakes/scripted-planner.js";
import { run, SIGN_IN, SITE, type Ran } from "./run-kit.js";

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

/** A sealed `kvfcu/sign_in@1`: clicks SITE's "Sign In" button from `/` to `/home`. */
const SESSION_ARTIFACT = Artifact.parse({
  schema: "intyy.artifact/1.0",
  identity: { app: "kvfcu", capability: "sign_in", version: "1.0.0" },
  runs_on: {
    surface: "web",
    app_versions: ["9.*"],
    viewport: { width: 1280, height: 800, scale: 1 },
    entry: "/",
    paths: ["/", "/home"],
    session: null,
  },
  about: {
    title: "Sign in",
    summary: "Signs in to the bank app.",
    when_to_use: "Use as the shared session for every task.",
    limits: "Signs in only. It does no task work.",
  },
  contract: { inputs: [], outputs: [], outcomes: [], effect: "read_only" },
  targets: [
    {
      id: "login_button",
      description: "The Sign In button on the start page",
      clues: { role: "button", name: "Sign In", text: "Sign In" },
    },
  ],
  conditions: [
    { id: "start_shown", check: "location", description: "The start page is showing", pattern: "/" },
    { id: "home_shown", check: "location", description: "The home page is showing", pattern: "/home" },
  ],
  steps: [
    {
      id: "click_login",
      intent: "Log in",
      action: { type: "click", target: "login_button" },
      precondition: "start_shown",
      checkpoint: "home_shown",
      outcomes: [],
      risk: "idempotent",
      timeout_ms: 5000,
    },
  ],
  provenance: {
    runs: [
      {
        run_id: "run_2026-09-28_1000000000",
        kind: "discovery",
        goal: "Sign in to the bank app.",
        model: "claude-sonnet-5",
        recorder_version: "0.1.0",
      },
    ],
    derived_from: null,
    actions: [],
    decisions: [],
    sealed: null,
  },
});

/** A spec that links the session artifact above, and starts its own turn at `/home`. */
const LINKED_SPEC = RunSpec.parse({
  ...SIGN_IN,
  capability: "transfer",
  goal: "Confirm the teller workstation is showing.",
  session: "kvfcu/sign_in@1",
  entry: "/home",
});

describe("the discovery prelude (section 6 §5.5, section 7 §10)", () => {
  test("runs the session artifact first, then spec.entry, then the loop starts there", async () => {
    const planner = new ScriptedPlanner([{ name: "done", input: { summary: "On the home page.", proof: ["e1"] } }]);
    const r = await go({ spec: LINKED_SPEC, sealedSession: SESSION_ARTIFACT, planner, site: SITE });

    expect(r.result).toMatchObject({ status: "success", code: null });

    // The prelude's own gate lines: navigate to the session's entry, then its one step.
    const gateSteps = r.events.filter((e) => e.event === "gate").map((e) => e.step);
    expect(gateSteps).toContain("session:entry");
    expect(gateSteps).toContain("session:click_login");
    // The engine's own navigate to spec.entry, after the prelude, before the loop.
    expect(gateSteps).toContain("entry");

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
});
