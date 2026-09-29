// Proves collect.ts step 1 (section 6 §14.2): every action, in order, with the screen locations
// before and after it, from a saved log.
import { describe, expect, test } from "vitest";
import { collectActions } from "../../../src/core/recorder/collect.js";
import { loadLog } from "./helpers.js";

describe("collectActions", () => {
  test("collects each action in order, with its before and after location", () => {
    const lines = loadLog("sign_in_basic.jsonl");
    const actions = collectActions("run_2026-09-24_0000000001", lines);
    expect(actions).toHaveLength(3);
    expect(actions.map((a) => a.tool)).toEqual(["type", "type", "click"]);
    expect(actions[0]).toMatchObject({
      seq: 3,
      turn: 1,
      target: "e2",
      value: "{secret.operator_username}",
      beforeLocation: "/login.do",
      afterLocation: "/login.do",
      tag: "flow_step",
      gateRisk: "idempotent",
    });
    const click = actions[2];
    expect(click).toMatchObject({
      turn: 3,
      beforeLocation: "/login.do",
      afterLocation: "/main.do",
      riskHint: null,
      gateRisk: "idempotent",
    });
    expect(click?.fingerprint?.name).toBe("Login");
  });

  test("no observation for a turn is a bug, and throws", () => {
    const broken = [
      {
        seq: 1,
        at: "2026-09-24T10:00:00.000Z",
        run_id: "run_x",
        step: "t1",
        by: "llm",
        event: "action",
        data: {
          type: "click",
          target: "e1",
          value: null,
          format: null,
          result: "ok",
          dispatched: true,
          transport: "live",
          tag: "flow_step",
          reason: "r",
          expected: "e",
          corrects: null,
          fingerprint: null,
        },
      },
    ];
    expect(() => collectActions("run_x", broken)).toThrow("no observation logged for turn 1");
  });
});
