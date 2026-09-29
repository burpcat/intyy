// Proves targets.ts step 4 (section 6 §14.2, §14.4): one target per distinct control, an added
// container target when a control is not unique on its screen, and clash numbering on the ID.
import { describe, expect, test } from "vitest";
import { collectActions } from "../../../src/core/recorder/collect.js";
import { applyTags, keptActions } from "../../../src/core/recorder/tags.js";
import { buildTargets, slugify, stripMaskTokens } from "../../../src/core/recorder/targets.js";
import { loadLog } from "./helpers.js";

function keptFrom(file: string, runId: string) {
  const actions = collectActions(runId, loadLog(file));
  return keptActions(applyTags(actions, []));
}

describe("buildTargets", () => {
  test("one target per distinct control, by role and structure path", () => {
    const kept = keptFrom("sign_in_basic.jsonl", "run_2026-09-24_0000000001");
    const { targets, targetIdOf } = buildTargets(kept);
    expect(targets.map((t) => t.id)).toEqual(["user_id_box", "password_box", "login_button"]);
    expect(targets[0]?.clues).toMatchObject({ role: "textbox", label: "User ID" });
    expect(targets[2]?.clues).toMatchObject({ role: "button", name: "Login", image: "crops/login_button.png" });
    expect(targetIdOf.get(kept[2] as (typeof kept)[number])).toBe("login_button");
  });

  test("a non-unique control gets a `within` container target, and a clash on the ID is numbered", () => {
    const kept = keptFrom("within_container.jsonl", "run_2026-09-24_0000000004");
    const { targets, crops } = buildTargets(kept);
    const buttons = targets.filter((t) => t.clues.role === "button");
    expect(buttons.map((t) => t.id)).toEqual(["edit_button", "edit_button_2"]);
    expect(buttons[0]?.within).toBe("member_a_row");
    expect(buttons[1]?.within).toBe("member_b_row");
    const containers = targets.filter((t) => t.clues.role === "row");
    expect(containers.map((t) => t.id)).toEqual(["member_a_row", "member_b_row"]);
    expect(crops.get("edit_button")).toBe("crops/00002_e5.png");
  });
});

describe("stripMaskTokens", () => {
  test("drops a mask token but keeps a reference (section 2 §21's member_row)", () => {
    expect(stripMaskTokens("{input.member_id} [name#1]")).toBe("{input.member_id}");
    expect(stripMaskTokens("[name#1]")).toBeNull();
    expect(stripMaskTokens("  ")).toBeNull();
  });
});

describe("slugify", () => {
  test("lower-cases and joins words with underscores", () => {
    expect(slugify("Member ID")).toBe("member_id");
    expect(slugify("Log In!")).toBe("log_in");
  });
});
