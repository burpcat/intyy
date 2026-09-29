// Proves steps.ts (section 6 §14.2 steps 3 to 5, §14.3, §14.11): one step per kept action, its
// target, precondition, checkpoint, and a draft timeout, end to end from a saved log.
import { describe, expect, test } from "vitest";
import { collectActions } from "../../../src/core/recorder/collect.js";
import { buildSteps, type Snapshots } from "../../../src/core/recorder/steps.js";
import { applyTags, keptActions } from "../../../src/core/recorder/tags.js";
import { loadLog } from "./helpers.js";

function stepsFor(file: string, runId: string) {
  const actions = collectActions(runId, loadLog(file));
  const kept = keptActions(applyTags(actions, []));
  return buildSteps(kept);
}

describe("buildSteps", () => {
  test("one step per kept action, with its own target, precondition, and checkpoint", () => {
    const { steps, conditions, targets, issues } = stepsFor(
      "sign_in_basic.jsonl",
      "run_2026-09-24_0000000001",
    );
    expect(issues).toEqual([]);
    expect(steps.map((s) => s.id)).toEqual(["type_user_id", "type_password", "click_login"]);
    expect(targets.map((t) => t.id)).toEqual(["user_id_box", "password_box", "login_button"]);

    expect(steps[0]).toMatchObject({
      action: { type: "type", target: "user_id_box", value: "{secret.operator_username}" },
      risk: "idempotent",
      timeout_ms: 5000,
    });
    expect(steps[2]).toMatchObject({
      action: { type: "click", target: "login_button" },
      timeout_ms: 10_000,
    });

    const byId = new Map(conditions.map((c) => [c.id, c]));
    expect(byId.get(steps[0]?.checkpoint ?? "")).toMatchObject({
      check: "field_value",
      target: "user_id_box",
      value: "*",
      match: "wildcard",
    });
    expect(byId.get(steps[2]?.precondition ?? "")).toMatchObject({
      check: "all_of",
      checks: [
        { check: "location", pattern: "/login.do" },
        { ref: steps[0]?.checkpoint },
        { ref: steps[1]?.checkpoint },
      ],
    });
    expect(byId.get(steps[2]?.checkpoint ?? "")).toMatchObject({
      check: "location",
      pattern: "/main.do",
    });
  });

  test("a repeated `type` into the same target keeps only the last one", () => {
    const { steps } = stepsFor("repeated_type.jsonl", "run_2026-09-24_0000000002");
    expect(steps.map((s) => s.id)).toEqual(["type_member_id", "click_search"]);
    expect(steps[0]?.action).toMatchObject({ value: "{input.member_id}" });
  });

  test("with no approval hint and no gate risk line, risk drafts irreversible and is flagged", () => {
    // repeated_type.jsonl has no `gate` lines and no approval escalation.
    const { steps, issues } = stepsFor("repeated_type.jsonl", "run_2026-09-24_0000000002");
    expect(steps.every((s) => s.risk === "irreversible")).toBe(true);
    expect(issues.filter((i) => i.code === "no_risk_class")).toHaveLength(2);
  });

  test("a click checkpoint adds one new landmark from the saved snapshots", () => {
    const actions = collectActions(
      "run_2026-09-24_0000000004",
      loadLog("within_container.jsonl"),
    );
    const kept = keptActions(applyTags(actions, []));
    const snapshots: Snapshots = {
      a11yByTurn: new Map([
        [1, '- button "Edit"\n- button "Edit"'],
        [2, '- heading "Edit Member A"\n- button "Edit"'],
      ]),
      proof: null,
      proofElementListText: null,
    };
    const { steps, conditions } = buildSteps(kept, snapshots);
    const checkpoint = conditions.find((c) => c.id === steps[0]?.checkpoint);
    expect(checkpoint).toMatchObject({ check: "all_of" });
    expect(JSON.stringify(checkpoint)).toContain("Edit Member A");
  });

  test("the last step's checkpoint uses done.proof's text when the snapshots supply it", () => {
    const { steps: base } = stepsFor("sign_in_basic.jsonl", "run_2026-09-24_0000000001");
    const actions = collectActions(
      "run_2026-09-24_0000000001",
      loadLog("sign_in_basic.jsonl"),
    );
    const kept = keptActions(applyTags(actions, []));
    const snapshots: Snapshots = {
      a11yByTurn: new Map(),
      proof: { turn: 4, ids: ["e1"] },
      proofElementListText: 'e1 heading "Welcome, teller"',
    };
    const { steps, conditions } = buildSteps(kept, snapshots);
    expect(steps.map((s) => s.id)).toEqual(base.map((s) => s.id));
    const last = steps[steps.length - 1];
    const checkpoint = conditions.find((c) => c.id === last?.checkpoint);
    expect(checkpoint).toMatchObject({ check: "text_visible", text: "Welcome, teller" });
  });

  test("a proof element with no text falls back to the after-location, with a blocking issue", () => {
    const actions = collectActions(
      "run_2026-09-24_0000000001",
      loadLog("sign_in_basic.jsonl"),
    );
    const kept = keptActions(applyTags(actions, []));
    const snapshots: Snapshots = {
      a11yByTurn: new Map(),
      proof: { turn: 4, ids: ["e9"] },
      proofElementListText: 'e1 heading "Welcome, teller"',
    };
    const { steps, conditions, issues } = buildSteps(kept, snapshots);
    const last = steps[steps.length - 1];
    const checkpoint = conditions.find((c) => c.id === last?.checkpoint);
    expect(checkpoint).toMatchObject({ check: "location", pattern: "/main.do" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      level: "blocking",
      code: "no_proof_text",
      subject: "run_2026-09-24_0000000001#done",
    });
    expect(issues[0]?.message).toContain("falls back to the after-location");
  });

  test("select, set_checked, and press become blocking issues, not fabricated steps", () => {
    const RUN = "run_2026-09-24_0000000009";
    const actions = collectActions(RUN, [
      {
        seq: 1,
        at: "2026-09-24T15:00:00.000Z",
        run_id: RUN,
        step: "t1",
        by: "engine",
        event: "observation",
        data: { location: "/account/new", title: "New account", elements: 4, files: [], marked: false },
      },
      {
        seq: 2,
        at: "2026-09-24T15:00:01.000Z",
        run_id: RUN,
        step: "t1",
        by: "llm",
        event: "action",
        data: {
          type: "select",
          target: "e2",
          value: null,
          format: null,
          result: "ok",
          dispatched: true,
          transport: "live",
          tag: "flow_step",
          reason: "Choose savings.",
          expected: "Savings is chosen.",
          corrects: null,
          fingerprint: {
            role: "combobox",
            name: null,
            label: "Account Type",
            text: null,
            region: null,
            crop: null,
            crop_dropped: "no_crop_rule",
            path: "form > select[1]",
            within: null,
            max_length: null,
            field_kind: "choice",
            uniqueness: 1,
          },
        },
      },
    ]);
    const kept = keptActions(applyTags(actions, []));
    const { steps, issues } = buildSteps(kept);
    expect(steps).toEqual([]);
    expect(issues).toEqual([
      {
        level: "blocking",
        code: "unsupported_step_action",
        subject: `${RUN}#2`,
        message: "select at t1 cannot become a step: the log does not record its value.",
      },
    ]);
  });
});
