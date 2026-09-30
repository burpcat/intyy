// Proves conditions.ts step 5 (section 6 §14.5): a condition's text stays stable across runs,
// and `ConditionRegistry` reuses one ID for two identical checks.
import { describe, expect, test } from "vitest";
import type { Target } from "../../../src/core/model/artifact/targets.js";
import {
  ConditionRegistry,
  allOf,
  elementVisibleCheck,
  fieldValueCheck,
  findProofText,
  locationCheck,
  newLandmarks,
  proofChecks,
  stabilize,
  textVisibleCheck,
} from "../../../src/core/recorder/conditions.js";
import { fromA11ySnapshot } from "../../../src/core/targets/a11y-snapshot.js";

describe("stabilize", () => {
  test("a mask token, an output reference, and a date or time all become *", () => {
    expect(stabilize("Hello [name#1], welcome")).toBe("Hello *, welcome");
    expect(stabilize("Account {output.account_number} created")).toBe("Account * created");
    expect(stabilize("Last login 2026-09-24 at 09:15")).toBe("Last login * at *");
  });

  test("an {input.*} reference stays: it is a parameter, not an observed fact", () => {
    expect(stabilize("Member {input.member_id} found")).toBe("Member {input.member_id} found");
  });

  test("a {secret.*} reference becomes *: it is the masked form of a secret shown on screen", () => {
    expect(stabilize("Welcome, {secret.operator_username}")).toBe("Welcome, *");
  });

  test("a {result.*} reference becomes *: section 2 §7.2 forbids it outside a reconciliation output", () => {
    expect(stabilize("Balance {result.new_balance} confirmed")).toBe("Balance * confirmed");
  });
});

describe("fieldValueCheck", () => {
  test("a secret's checkpoint checks only that something was typed, never the value", () => {
    expect(fieldValueCheck("password_box", "{secret.operator_password}")).toEqual({
      check: "field_value",
      target: "password_box",
      value: "*",
      match: "wildcard",
    });
  });

  test("a plain value is kept, stabilized, and matched exactly", () => {
    expect(fieldValueCheck("notes_box", "Ref {output.account_number} noted")).toEqual({
      check: "field_value",
      target: "notes_box",
      value: "Ref * noted",
      match: "exact",
    });
  });
});

describe("textVisibleCheck", () => {
  test("stabilizes its text and matches by contains", () => {
    expect(textVisibleCheck("Account {output.account_number} created")).toEqual({
      check: "text_visible",
      text: "Account * created",
      match: "contains",
    });
    expect(textVisibleCheck("created", "confirmation_message")).toMatchObject({
      within: "confirmation_message",
    });
  });
});

describe("newLandmarks", () => {
  test("a heading present after and absent before is a new landmark", () => {
    const before = fromA11ySnapshot('- textbox "Username"\n- textbox "Password"', "/login");
    const after = fromA11ySnapshot('- heading "Welcome, teller"\n- link "Transfers"', "/home");
    expect(newLandmarks(before, after)).toEqual(["Welcome, teller"]);
  });

  test("a heading present on both screens is not new", () => {
    const before = fromA11ySnapshot('- heading "Members"', "/members");
    const after = fromA11ySnapshot('- heading "Members"\n- text: 1 result', "/members");
    expect(newLandmarks(before, after)).toEqual(["1 result"]);
  });
});

describe("findProofText", () => {
  test("finds the quoted words on the proof element's own line", () => {
    const list = 'e1 heading "Welcome, teller" {\n  e2 link "Transfers"\n}';
    expect(findProofText(list, "e1")).toBe("Welcome, teller");
    expect(findProofText(list, "e2")).toBe("Transfers");
    expect(findProofText(list, "e9")).toBeNull();
  });
});

describe("proofChecks", () => {
  test("drops a check whose text is only * once stabilized, and falls back to null when every id does", () => {
    const list = 'e1 heading "{secret.operator_username}"';
    expect(proofChecks(list, ["e1"], [])).toBeNull();
  });

  test("keeps one useful id and drops another that stabilizes to nothing, in an all_of", () => {
    const list = 'e1 heading "{secret.operator_username}"\ne2 heading "Welcome, teller"';
    const checks = proofChecks(list, ["e1", "e2"], []);
    expect(checks).toEqual([{ check: "text_visible", text: "Welcome, teller", match: "contains" }]);
  });

  test("null when any id's text is missing, same as today", () => {
    const list = 'e1 heading "Welcome, teller"';
    expect(proofChecks(list, ["e1", "e9"], [])).toBeNull();
  });

  test("an ellipsis-cut text drops its partial last word, dropping the … itself", () => {
    const list = 'e1 heading "Member Jordan Ríos-Alvarad…"';
    const checks = proofChecks(list, ["e1"], []);
    expect(checks).toEqual([{ check: "text_visible", text: "Member Jordan", match: "contains" }]);
  });

  test("an ellipsis-cut text that ends exactly on a word boundary keeps the whole word", () => {
    const list = 'e1 heading "Member Jordan …"';
    const checks = proofChecks(list, ["e1"], []);
    expect(checks).toEqual([{ check: "text_visible", text: "Member Jordan", match: "contains" }]);
  });

  test("text carrying a swapped quote or angle bracket is dropped, never matched as-is", () => {
    const list = 'e1 heading "Say ‹hi› to O\'Brien"';
    expect(proofChecks(list, ["e1"], [])).toBeNull();
  });

  test("scopes the check within a recorded target with the same role and words", () => {
    const list = 'e1 button "Login"';
    const targets: Target[] = [
      { id: "login_button", description: "Login", clues: { role: "button", name: "Login" } },
    ];
    const checks = proofChecks(list, ["e1"], targets);
    expect(checks).toEqual([
      { check: "text_visible", text: "Login", match: "contains", within: "login_button" },
    ]);
  });

  test("stays page-wide when no recorded target matches", () => {
    const list = 'e1 heading "Welcome, teller"';
    const targets: Target[] = [
      { id: "login_button", description: "Login", clues: { role: "button", name: "Login" } },
    ];
    const checks = proofChecks(list, ["e1"], targets);
    expect(checks).toEqual([{ check: "text_visible", text: "Welcome, teller", match: "contains" }]);
  });
});

describe("ConditionRegistry", () => {
  test("reuses one ID for two steps whose check is exactly the same shape", () => {
    const registry = new ConditionRegistry();
    const check = allOf([locationCheck("/login.do"), elementVisibleCheck("username_box")]);
    const first = registry.intern(check, "type_username_precondition", "Before typing the user ID.");
    const second = registry.intern(check, "type_password_precondition", "Before typing the password.");
    expect(second).toBe(first);
    expect(registry.list()).toHaveLength(1);
  });

  test("numbers a clash when two different checks want the same ID", () => {
    const registry = new ConditionRegistry();
    const a = registry.intern(locationCheck("/login.do"), "shown", "d1");
    const b = registry.intern(locationCheck("/home.do"), "shown", "d2");
    expect([a, b]).toEqual(["shown", "shown_2"]);
  });
});
