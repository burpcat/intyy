// Proves conditions.ts step 5 (section 6 §14.5): a condition's text stays stable across runs,
// and `ConditionRegistry` reuses one ID for two identical checks.
import { describe, expect, test } from "vitest";
import {
  ConditionRegistry,
  allOf,
  elementVisibleCheck,
  fieldValueCheck,
  findProofText,
  locationCheck,
  newLandmarks,
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
