// Proves the discovery loop on the snapshot surface: a scripted goal completes, and each way a
// run ends. Design section 6 §10, §6.2, §18 ("Loop with a fake LLM"); section 3 §6.4; section 9
// §5.3 (two model failures). M03 task 6.
import { afterEach, describe, expect, test } from "vitest";
import { RunSpec } from "../../../src/core/model/runspec.js";
import { ScriptedPlanner } from "../../../src/fakes/scripted-planner.js";
import { names, run, SIGN_IN, SIGN_IN_STEPS, type Ran } from "./run-kit.js";

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

const why = { reason: "Look around.", expected: "Something changes.", tag: "exploration" };

describe("a scripted sign-in (section 6 §10.1)", () => {
  test("completes with done accepted, and logs every part of each turn", async () => {
    const r = await go({});
    expect(r.result).toMatchObject({ status: "success", code: null });
    const ev = names(r.events);
    expect(ev[0]).toBe("run_start");
    expect(ev[1]).toBe("precheck");
    expect(ev).toContain("session");
    expect(ev.filter((e) => e === "observation")).toHaveLength(4);
    expect(ev.filter((e) => e === "llm_decision")).toHaveLength(4);
    expect(ev.filter((e) => e === "action")).toHaveLength(3);
    expect(ev.filter((e) => e === "gate")).toHaveLength(3);
    expect(ev.at(-1)).toBe("run_end");
    expect(r.events.at(-1)).toMatchObject({ data: { status: "success", code: null } });
    // Why: seq numbers count up with no gap, in file order (section 3 §6.1).
    expect(r.events.map((e) => e.seq)).toEqual(r.events.map((_, i) => i + 1));
  });

  test("saves the marked screenshot, the a11y snapshot, and each model call in llm/", async () => {
    const r = await go({});
    const paths = r.files.map((f) => f.path);
    expect(
      paths.filter((p) => p.startsWith("screens/") && p.endsWith("_observation.png")),
    ).toHaveLength(4);
    expect(paths.filter((p) => p.startsWith("a11y/"))).toHaveLength(4);
    expect(paths.filter((p) => /^llm\/\d{5}_planner_request\.json$/.test(p))).toHaveLength(4);
    expect(paths.filter((p) => /^llm\/\d{5}_planner_reply\.json$/.test(p))).toHaveLength(4);
    expect(paths).toContain("run.json");
  });

  test("the LLM sees the task, the screen, and its history; values stay out", async () => {
    const r = await go({});
    const seen = (r.planner as ScriptedPlanner).seen;
    expect(seen[0]?.system).toContain("- {secret.operator_username}");
    expect(seen[0]?.message).toContain('<screen location="/" title="Sign In">');
    expect(seen[0]?.message).toContain('e3 textbox label:"Username"');
    expect(seen[2]?.message).toContain('e5 textbox label:"Password" value:"[secret]"');
    expect(seen[2]?.message).toContain("t1 type e3 {secret.operator_username} → ok  [flow_step]");
    expect(seen[3]?.message).toContain('<screen location="/home" title="Teller Workstation">');
    expect(seen.every((t) => t.system === seen[0]?.system)).toBe(true);
  });

  test("the action line holds the fingerprint, with the visible label", async () => {
    const r = await go({});
    const first = r.events.find((e) => e.event === "action") as { data: Record<string, unknown> };
    expect(first.data).toMatchObject({
      type: "type",
      target: "e3",
      value: "{secret.operator_username}",
      result: "ok",
      dispatched: true,
      tag: "flow_step",
      fingerprint: { role: "textbox", label: "Username", field_kind: "text", uniqueness: 2 },
    });
  });
});

describe("facts in the log", () => {
  test("file paths, hashes, and the run ID are not masked as digit runs", async () => {
    const r = await go({});
    const obs = r.events.find((e) => e.event === "observation") as { data: { files: string[] } };
    expect(obs.data.files[0]).toMatch(/^screens\/\d{5}_observation\.png$/);
    expect(r.events[0]).toMatchObject({
      run_id: r.result.runId,
      data: { frozen: { settings: { hash: `sha256:${"0".repeat(64)}` } } },
    });
  });
});

describe("how a run ends (section 6 §10.4)", () => {
  test("two model failures in a row end the run model_unavailable", async () => {
    const r = await go({ steps: [{ failure: "timeout" }, { failure: "unavailable" }] });
    expect(r.result).toMatchObject({ status: "failed", code: "model_unavailable" });
    expect(r.events.at(-1)).toMatchObject({
      data: { status: "failed", code: "model_unavailable" },
    });
  });

  test("one failure is retried, and the run goes on; the retry keeps its own llm/ file", async () => {
    const r = await go({ steps: [{ failure: "timeout" }, ...SIGN_IN_STEPS] });
    expect(r.result.status).toBe("success");
    const llm = r.files.map((f) => f.path).filter((p) => p.startsWith("llm/"));
    const first = llm.find((p) => /^llm\/\d{5}_planner_request\.json$/.test(p));
    expect(first).toBeDefined();
    expect(llm).toContain((first ?? "").replace("_planner_request", "_2_planner_request"));
  });

  test("a failed llm/ write stops the call and the run", async () => {
    const planner = new ScriptedPlanner(SIGN_IN_STEPS);
    const r = await go({
      planner: {
        next: (turn) => planner.next(turn, () => Promise.resolve(false)),
      },
    });
    expect(r.result).toMatchObject({ status: "failed", code: "evidence_write_failed" });
    expect(planner.seen).toHaveLength(0);
  });

  test("max_steps ends the run discovery_limit", async () => {
    const spec = RunSpec.parse({ ...SIGN_IN, limits: { max_steps: 2 } });
    const r = await go({ spec, steps: SIGN_IN_STEPS.slice(0, 3) });
    expect(r.result).toMatchObject({ status: "failed", code: "discovery_limit" });
  });

  test("three bad calls in a row ask the operator; end_run ends it ended_by_operator", async () => {
    const r = await go({
      steps: [
        { name: "click", input: { element: "e99", ...why } },
        null,
        { name: "nope", input: {} },
      ],
    });
    expect(r.result).toMatchObject({ status: "failed", code: "ended_by_operator" });
    expect(r.operator.requests.map((q) => q.kind)).toEqual(["takeover"]);
    const seen = (r.planner as ScriptedPlanner).seen;
    expect(seen[1]?.message).toContain(
      "<feedback>unknown element e99. Use an ID from this turn's list.</feedback>",
    );
    expect(seen[2]?.message).toContain("<feedback>reply with exactly one tool call.</feedback>");
    expect(r.events.filter((e) => e.event === "escalation")).toMatchObject([
      { data: { kind: "takeover", reason: "stuck", state: "open" } },
      { data: { kind: "takeover", reason: "stuck", state: "resolved", decision: "end_run" } },
    ]);
  });

  test("three waits with no screen change ask the operator", async () => {
    const wait = { name: "wait", input: { reason: "Loading.", seconds: 3 } };
    const r = await go({ steps: [wait, wait, wait, ...SIGN_IN_STEPS] });
    expect(r.result.code).toBe("ended_by_operator");
    expect(r.operator.requests).toMatchObject([
      { kind: "takeover", trouble: { detail: "Waited 3 times with no change on screen." } },
    ]);
  });

  test("a stuck call asks the operator", async () => {
    const r = await go({ steps: [{ name: "stuck", input: { reason: "No sign-in form." } }] });
    expect(r.operator.requests[0]).toMatchObject({
      reason: "stuck",
      trouble: { detail: "No sign-in form." },
      decisions: ["end_run"],
    });
    expect(r.result.code).toBe("ended_by_operator");
  });

  test("a missing secret fails the start with no browser and no model call", async () => {
    const r = await go({ secrets: {} });
    expect(r.result).toMatchObject({ status: "failed", code: "secret_unavailable" });
    expect(names(r.events)).toEqual(["run_start", "precheck", "run_end"]);
    expect((r.planner as ScriptedPlanner).seen).toHaveLength(0);
  });

  test("a spec that needs M05's prelude is rejected with three log lines", async () => {
    const spec = RunSpec.parse({
      ...SIGN_IN,
      capability: "transfer",
      session: "kvfcu/sign_in@1",
      entry: "/home",
    });
    const r = await go({ spec });
    expect(r.result).toMatchObject({ status: "rejected", code: "invalid_request" });
    expect(names(r.events)).toEqual(["run_start", "precheck", "run_end"]);
  });
});

describe("gate feedback (section 6 §10.2)", () => {
  test("a blocked page is told in plain words, not the rule", async () => {
    const r = await go({
      steps: [
        { name: "navigate", input: { location: "/__test__/reset", ...why } },
        ...SIGN_IN_STEPS,
      ],
    });
    const seen = (r.planner as ScriptedPlanner).seen;
    expect(seen[1]?.message).toContain('last="blocked"');
    expect(seen[1]?.message).toContain(
      "<feedback>Blocked by policy: that page is not allowed. Find another way.</feedback>",
    );
    expect(seen[1]?.message).not.toContain("allowlist");
    expect(r.result.status).toBe("success");
  });

  test("a typed mask token is blocked and told", async () => {
    const r = await go({
      steps: [
        { name: "type", input: { element: "e3", value: "[name#1]", ...why } },
        ...SIGN_IN_STEPS,
      ],
    });
    const seen = (r.planner as ScriptedPlanner).seen;
    expect(seen[1]?.message).toContain(
      "<feedback>Blocked: you typed a mask token. Use a reference.</feedback>",
    );
  });
});

describe("approvals in discovery (section 4 §7.7)", () => {
  /** A commits spec that signs in, opens Transfers, and submits. */
  const TRANSFER = RunSpec.parse({
    ...SIGN_IN,
    capability: "transfer",
    goal: "Sign in, then submit the transfer.",
    expected_effect: "commits",
    correlation: "none",
  });
  const steps = [
    ...SIGN_IN_STEPS.slice(0, 3),
    { name: "click", input: { element: "e2", ...why, tag: "flow_step" } },
    { name: "click", input: { element: "e1", ...why, tag: "flow_step" } },
    { name: "done", input: { summary: "Posted.", proof: ["e1"] } },
  ];

  test("an irreversible click pauses; approve as irreversible acts and counts the commit", async () => {
    const r = await go({
      spec: TRANSFER,
      steps,
      answers: [{ staff: "op_017", decision: "approve_irreversible" }],
    });
    expect(r.operator.requests).toHaveLength(1);
    expect(r.operator.requests[0]).toMatchObject({
      kind: "approval",
      reason: "discovery_irreversible",
      approval: { words: "Submit Transfer", risk: "irreversible" },
      decisions: ["approve_irreversible", "approve_reversible", "approve_idempotent", "decline"],
    });
    expect(r.operator.closed).toEqual(["resolved"]);
    expect(r.result.status).toBe("success");
    const esc = r.events.filter((e) => e.event === "escalation");
    expect(esc).toMatchObject([
      { data: { kind: "approval", reason: "discovery_irreversible", state: "open" } },
      {
        data: {
          state: "resolved",
          decision: "approve_irreversible",
          risk_hint: "irreversible",
          staff_id: "op_017",
        },
      },
    ]);
  });

  test("decline does not act, and the LLM is told", async () => {
    const r = await go({
      spec: TRANSFER,
      steps,
      answers: [{ staff: "op_017", decision: "decline" }],
    });
    const seen = (r.planner as ScriptedPlanner).seen;
    expect(seen[5]?.message).toContain("<feedback>The operator declined that action.</feedback>");
    // Why: section 6 §10.3, done needs the one approved change first.
    expect(seen[6]?.message).toContain("done rejected: the one approved change has not happened.");
  });

  test("a read-only run is blocked from an irreversible click", async () => {
    const spec = RunSpec.parse({ ...SIGN_IN, capability: "transfer" });
    const r = await go({ spec, steps });
    const seen = (r.planner as ScriptedPlanner).seen;
    expect(seen[5]?.message).toContain(
      "<feedback>Blocked: this task must not change data.</feedback>",
    );
    expect(r.operator.requests).toHaveLength(0);
  });
});
