// Shared by the prelude and abort tests: a sealed session artifact that clicks SITE's "Sign In"
// button, and a spec that links it. Design section 6 §5.5. Values are made up.
import { Artifact } from "../../../src/core/model/artifact.js";
import { RunSpec } from "../../../src/core/model/runspec.js";
import { SIGN_IN } from "./run-kit.js";

/** A sealed `kvfcu/sign_in@1`: clicks SITE's "Sign In" button from `/` to `/home`. */
export const SESSION_ARTIFACT = Artifact.parse({
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
export const LINKED_SPEC = RunSpec.parse({
  ...SIGN_IN,
  capability: "transfer",
  goal: "Confirm the teller workstation is showing.",
  session: "kvfcu/sign_in@1",
  entry: "/home",
});
