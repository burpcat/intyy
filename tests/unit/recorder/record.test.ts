// Proves record.ts (section 6 §14.1, §14.2): one candidate artifact, deterministically, from a
// saved log, its spec, and the decisions so far.
import { describe, expect, test } from "vitest";
import { RunSpec } from "../../../src/core/model/runspec.js";
import { record } from "../../../src/core/recorder/record.js";
import { loadLog } from "./helpers.js";

const SIGN_IN_SPEC = RunSpec.parse({
  schema: "intyy.runspec/1.0",
  kind: "discovery",
  caller: { tenant: "keystone", agent_id: "op_017" },
  app: "kvfcu",
  capability: "sign_in",
  goal: "Sign in as the operator.",
  inputs: [],
  outputs: [],
  expected_effect: "read_only",
  session: null,
  entry: "/",
  model: "claude-sonnet-5",
  prompt: "discovery@1.0",
});

const CONTEXT = {
  tenant: "keystone",
  appVersion: "8.4",
  viewport: { width: 1280, height: 800, scale: 1 },
};

describe("record", () => {
  test("builds a candidate artifact deterministically from the sign_in log", () => {
    const input = {
      positive: {
        runId: "run_2026-09-24_0000000001",
        spec: SIGN_IN_SPEC,
        lines: loadLog("sign_in_basic.jsonl"),
      },
      decisions: [],
      context: CONTEXT,
    };
    const first = record(input);
    const second = record(input);
    expect(first).toEqual(second);

    expect(first.candidate.identity).toEqual({ app: "kvfcu", capability: "sign_in", version: null });
    expect(first.candidate.runs_on.paths).toEqual(["/", "/login.do", "/main.do"]);
    expect(first.candidate.steps.map((s) => s.id)).toEqual([
      "type_user_id",
      "type_password",
      "click_login",
    ]);
    expect(first.candidate.recovery).toBeUndefined();
    expect(first.candidate.contract.effect).toBe("read_only");
    expect(first.candidate.provenance.actions).toHaveLength(3);
    expect(first.candidate.provenance.actions.map((a) => a.became)).toEqual([
      "step:type_user_id",
      "step:type_password",
      "step:click_login",
    ]);
    expect(first.drafts).toEqual([]);
    expect(first.normalFixtures.map((f) => f.location)).toEqual(["/login.do"]);

    // Still a candidate: about is empty, and sealing needs a human to fill it in first.
    expect(first.issues.some((i) => i.level === "blocking")).toBe(true);
  });

  test("a rename applied last keeps an earlier risk decision attached, deterministically", () => {
    const runId = "run_2026-09-24_0000000006";
    const lines = [
      { seq: 1, at: "2026-09-24T10:00:00.000Z", run_id: runId, step: "t1", by: "engine", event: "observation", data: { location: "/menu.do", title: "Menu", elements: 3, files: [], marked: false } },
      { seq: 2, at: "2026-09-24T10:00:00.500Z", run_id: runId, step: "t1", by: "gate", why: { kind: "policy", ref: "risk.needs_approval" }, event: "gate", data: { actor: "llm", action: "click", decision: "needs_approval", risk: "irreversible" } },
      { seq: 3, at: "2026-09-24T10:00:01.000Z", run_id: runId, step: "t1", by: "llm", event: "action", data: { type: "click", target: "e2", value: null, format: null, result: "ok", dispatched: true, transport: "live", tag: "flow_step", reason: "Post the change.", expected: "It posts.", corrects: null, fingerprint: { role: "button", name: "Post", label: null, text: "Post", region: null, crop: null, crop_dropped: "no_crop_rule", path: "form > button[1]", within: null, max_length: null, field_kind: null, uniqueness: 1 } } },
      { seq: 4, at: "2026-09-24T10:00:02.000Z", run_id: runId, step: "t2", by: "engine", event: "observation", data: { location: "/menu.do", title: "Menu", elements: 3, files: [], marked: false } },
    ];
    const spec = RunSpec.parse({ ...SIGN_IN_SPEC, entry: "/menu.do" });
    const decisions = [
      { schema: "intyy.candidate_decision/1.0" as const, what: "risk" as const, subject: "click_post", value: "idempotent", by: "op_017", at: "2026-09-24T14:00:00Z" },
      { schema: "intyy.candidate_decision/1.0" as const, what: "risk_second_look" as const, subject: "click_post", value: "idempotent", by: "op_022", at: "2026-09-24T14:01:00Z" },
      { schema: "intyy.candidate_decision/1.0" as const, what: "edit" as const, subject: "steps.click_post.id", value: "click_post_it", by: "op_017", at: "2026-09-24T14:02:00Z" },
    ];
    const input = { positive: { runId, spec, lines }, decisions, context: CONTEXT };
    const first = record(input);
    const second = record(input);
    expect(first).toEqual(second);

    expect(first.candidate.steps.map((s) => s.id)).toEqual(["click_post_it"]);
    expect(first.candidate.steps[0]?.risk).toBe("idempotent");
    expect(first.issues.some((i) => i.code === "risk_second_look")).toBe(false);
  });
});
