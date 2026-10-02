// Proves targets.ts step 4 (section 6 §14.2, §14.4): one target per distinct control, an added
// container target when a control is not unique on its screen, and clash numbering on the ID.
import { describe, expect, test } from "vitest";
import { collectActions } from "../../../src/core/recorder/collect.js";
import { applyTags, keptActions } from "../../../src/core/recorder/tags.js";
import {
  buildTargets,
  pickId,
  screenNameOf,
  slugify,
  stripMaskTokens,
} from "../../../src/core/recorder/targets.js";
import { loadLog } from "./helpers.js";

function keptFrom(file: string, runId: string) {
  const actions = collectActions(runId, loadLog(file));
  return keptActions(applyTags(actions, []));
}

describe("buildTargets", () => {
  test("buildTargets builds one target per control, adds within and ID clashes, and labels read values", () => {
    {
      // one target per distinct control, by role and structure path
      const kept = keptFrom("sign_in_basic.jsonl", "run_2026-09-24_0000000001");
      const { targets, targetIdOf } = buildTargets(kept);
      expect(targets.map((t) => t.id)).toEqual(["user_id_box", "password_box", "login_button"]);
      expect(targets[0]?.clues).toMatchObject({ role: "textbox", label: "User ID" });
      expect(targets[2]?.clues).toMatchObject({ role: "button", name: "Login", image: "crops/login_button.png" });
      expect(targetIdOf.get(kept[2] as (typeof kept)[number])).toBe("login_button");
    }
    {
      // a non-unique control gets a `within` container target, and a clash on the ID adds the screen's name
      const kept = keptFrom("within_container.jsonl", "run_2026-09-24_0000000004");
      const { targets, crops } = buildTargets(kept);
      const buttons = targets.filter((t) => t.clues.role === "button");
      expect(buttons.map((t) => t.id)).toEqual(["edit_button", "edit_button_list"]);
      expect(buttons[0]?.within).toBe("member_a_row");
      expect(buttons[1]?.within).toBe("member_b_row");
      const containers = targets.filter((t) => t.clues.role === "row");
      expect(containers.map((t) => t.id)).toEqual(["member_a_row", "member_b_row"]);
      expect(crops.get("edit_button")).toBe("crops/00002_e5.png");
    }
    {
      // a container named with a mask token gives no `within`: the live name never holds the token
      const kept = keptFrom("within_container.jsonl", "run_2026-09-24_0000000004").map((a, i) =>
        i === 0 && a.fingerprint !== null ? { ...a, fingerprint: { ...a.fingerprint, within: 'row "Member A [money#1]"' } } : a,
      );
      const { targets } = buildTargets(kept);
      const buttons = targets.filter((t) => t.clues.role === "button");
      expect(buttons[0]?.within).toBeUndefined();
      expect(buttons[1]?.within).toBe("member_b_row");
      expect(targets.filter((t) => t.clues.role === "row").map((t) => t.id)).toEqual(["member_b_row"]);
    }
    {
      // a read value with no words of its own takes its row's other words as its label
      const kept = keptFrom("within_container.jsonl", "run_2026-09-24_0000000004").map((a, i) =>
        i === 0 && a.fingerprint !== null
          ? {
              ...a,
              fingerprint: {
                ...a.fingerprint,
                role: "generic",
                name: "{output.account_number}",
                text: "{output.account_number}",
                within: 'row "Account No. {output.account_number}"',
                uniqueness: 1,
              },
            }
          : a,
      );
      const { targets } = buildTargets(kept);
      expect(targets[0]).toMatchObject({ id: "account_no_generic", clues: { role: "generic", label: "Account No." } });
      expect(targets[0]?.clues).not.toHaveProperty("name");
    }
  });
});

describe("stripMaskTokens", () => {
  test("drops a mask token but keeps a reference (section 2 §21's member_row)", () => {
    expect(stripMaskTokens("{input.member_id} [name#1]")).toBe("{input.member_id}");
    expect(stripMaskTokens("[name#1]")).toBeNull();
    expect(stripMaskTokens("  ")).toBeNull();
  });
});

describe("pickId", () => {
  test("adds the screen's name on a clash, then falls back to numbering", () => {
    expect(pickId("edit_button", new Set(), "list")).toBe("edit_button");
    expect(pickId("edit_button", new Set(["edit_button"]), "list")).toBe("edit_button_list");
    expect(
      pickId("edit_button", new Set(["edit_button", "edit_button_list"]), "list"),
    ).toBe("edit_button_2");
    expect(pickId("edit_button", new Set(["edit_button"]))).toBe("edit_button_2");
  });
});

describe("screenNameOf", () => {
  test("the last path segment, without its extension", () => {
    expect(screenNameOf("/login.do")).toBe("login");
    expect(screenNameOf("/members/list")).toBe("list");
    expect(screenNameOf("/")).toBe("");
  });
});

describe("slugify", () => {
  test("lower-cases and joins words with underscores", () => {
    expect(slugify("Member ID")).toBe("member_id");
    expect(slugify("Log In!")).toBe("log_in");
  });
});
