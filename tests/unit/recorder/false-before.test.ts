// Proves the "false before" check (principle 2.3, section 6 §14.5): the recorder tests each
// step's checkpoint on the screen right before its action. True there is a blocking issue;
// unknown (an a11y snapshot never carries field values) is only ever a warning.
import { describe, expect, test } from "vitest";
import { evaluate } from "../../../src/core/targets/evaluate.js";
import { fromA11ySnapshot } from "../../../src/core/targets/a11y-snapshot.js";
import { allOf, elementVisibleCheck, locationCheck } from "../../../src/core/recorder/conditions.js";
import { buildSteps, type Snapshots } from "../../../src/core/recorder/steps.js";
import type { TaggedAction } from "../../../src/core/recorder/tags.js";

const EMPTY: Snapshots = { a11yByTurn: new Map(), proof: null, proofElementListText: null };

/** One action, with sane defaults for the fields this file's fixtures never vary. */
function action(partial: Partial<TaggedAction> & Pick<TaggedAction, "turn" | "tool">): TaggedAction {
  return {
    runId: "run_2026-09-24_false_before",
    seq: partial.turn,
    target: null,
    value: null,
    format: null,
    option: null,
    checked: null,
    key: null,
    result: "ok",
    dispatched: true,
    tag: "flow_step",
    humanTag: null,
    effectiveTag: "flow_step",
    reason: "x",
    expected: "y",
    corrects: null,
    fingerprint: null,
    beforeLocation: "/page",
    afterLocation: "/page",
    at: `2026-09-24T10:00:0${String(partial.turn)}.000Z`,
    afterAt: `2026-09-24T10:00:0${String(partial.turn + 1)}.000Z`,
    riskHint: "idempotent",
    riskHintBy: null,
    gateRisk: null,
    ...partial,
  };
}

describe("checkFalseBefore: caught", () => {
  test("a checkbox already checked before set_checked is a blocking issue", () => {
    const a = action({
      turn: 1,
      tool: "set_checked",
      checked: true,
      target: "e2",
      fingerprint: {
        role: "checkbox",
        name: "Remember me",
        label: null,
        text: null,
        region: null,
        crop: null,
        crop_dropped: "no_crop_rule",
        path: "form > input[3]",
        within: null,
        max_length: null,
        field_kind: "check",
        uniqueness: 1,
      },
    });
    const snapshots: Snapshots = {
      a11yByTurn: new Map([[1, '- checkbox "Remember me" [checked]']]),
      proof: null,
      proofElementListText: null,
    };
    const { issues } = buildSteps([a], snapshots);
    expect(issues).toMatchObject([{ level: "blocking", code: "checkpoint_true_before" }]);
  });
});

describe("checkFalseBefore: a landmark fixes it", () => {
  const showDetails = action({
    turn: 1,
    tool: "click",
    target: "e2",
    fingerprint: {
      role: "button",
      name: "Expand",
      label: null,
      text: "Expand",
      region: null,
      crop: "crops/00002_e2.png",
      crop_dropped: null,
      path: "form > button[1]",
      within: null,
      max_length: null,
      field_kind: null,
      uniqueness: 1,
    },
  });
  const clickOk = action({
    turn: 2,
    tool: "click",
    target: "e3",
    fingerprint: {
      role: "button",
      name: "OK",
      label: null,
      text: "OK",
      region: null,
      crop: "crops/00004_e3.png",
      crop_dropped: null,
      path: "form > button[2]",
      within: null,
      max_length: null,
      field_kind: null,
      uniqueness: 1,
    },
  });
  const BEFORE = '- button "Expand"\n- button "OK"';
  const AFTER = '- button "Expand"\n- button "OK"\n- heading "Details"';

  test("a landmark fixes a screen condition that is true before the click", () => {
    {
      // without the landmark, the plain screen condition is already true before the click
      const before = fromA11ySnapshot(BEFORE, "/page");
      const withoutLandmark = allOf([locationCheck("/page"), elementVisibleCheck("ok_button")]);
      const answer = evaluate(withoutLandmark, before, {
        targets: new Map([["ok_button", { id: "ok_button", description: "x", clues: { role: "button", name: "OK" } }]]),
      });
      expect(answer).toBe("true");
    }
    {
      // the recorder's own checkpoint adds the landmark, so no issue is raised
      const snapshots: Snapshots = {
        a11yByTurn: new Map([
          [1, BEFORE],
          [2, AFTER],
          // Turn 3, right after clicking OK: its own landmark, so click_ok's checkpoint is not
          // the plain "still on /page" check this fixture would otherwise leave it with.
          [3, `${AFTER}\n- heading "Saved"`],
        ]),
        proof: null,
        proofElementListText: null,
      };
      const { issues, steps, conditions } = buildSteps([showDetails, clickOk], snapshots);
      expect(issues).toEqual([]);
      const checkpoint = conditions.find((c) => c.id === steps[0]?.checkpoint);
      expect(JSON.stringify(checkpoint)).toContain("Details");
    }
  });
});

describe("checkFalseBefore: unknown gives a warning", () => {
  test("an unknown type checkpoint warns, never blocks, and no snapshot stays silent", () => {
    {
      // a11y carries no field values, so a type checkpoint is always unknown, never a pass or a block
      const a = action({
        turn: 1,
        tool: "type",
        target: "e2",
        value: "{secret.operator_username}",
        fingerprint: {
          role: "textbox",
          name: null,
          label: "Username",
          text: null,
          region: null,
          crop: null,
          crop_dropped: "no_crop_rule",
          path: "form > input[1]",
          within: null,
          max_length: null,
          field_kind: "text",
          uniqueness: 1,
        },
      });
      const snapshots: Snapshots = {
        a11yByTurn: new Map([[1, '- textbox "Username"']]),
        proof: null,
        proofElementListText: null,
      };
      const { issues } = buildSteps([a], snapshots);
      expect(issues).toMatchObject([{ level: "warning", code: "checkpoint_unknown_before" }]);
      expect(issues.some((i) => i.level === "blocking")).toBe(false);
    }
    {
      // a secret type step with a `*` checkpoint still warns checkpoint_unknown_before, never blocks
      const a = action({
        turn: 1,
        tool: "type",
        target: "e2",
        value: "{secret.operator_password}",
        fingerprint: {
          role: "textbox",
          name: null,
          label: "Password",
          text: null,
          region: null,
          crop: null,
          crop_dropped: "no_crop_rule",
          path: "form > input[2]",
          within: null,
          max_length: null,
          field_kind: "password",
          uniqueness: 1,
        },
      });
      const snapshots: Snapshots = {
        a11yByTurn: new Map([[1, '- textbox "Password"']]),
        proof: null,
        proofElementListText: null,
      };
      const { conditions, issues } = buildSteps([a], snapshots);
      // Why: pins that the checkpoint under test is the `*` wildcard (section 6 §14.5).
      expect(conditions).toContainEqual(expect.objectContaining({ check: "field_value", value: "*", match: "wildcard" }));
      expect(issues).toMatchObject([{ level: "warning", code: "checkpoint_unknown_before" }]);
      expect(issues.some((i) => i.level === "blocking")).toBe(false);
    }
    {
      // with no saved snapshot for the turn, the check is silent
      const a = action({ turn: 1, tool: "type", target: "e2", value: "{input.x}" });
      const { issues } = buildSteps([a], EMPTY);
      expect(issues.some((i) => i.code === "checkpoint_true_before" || i.code === "checkpoint_unknown_before")).toBe(
        false,
      );
    }
  });
});
