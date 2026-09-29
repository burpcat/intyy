// Proves conditions.ts step 5 (section 6 §14.5): a condition's text stays stable across runs,
// and `ConditionRegistry` reuses one ID for two identical checks.
import { describe, expect, test } from "vitest";
import {
  ConditionRegistry,
  allOf,
  elementVisibleCheck,
  fieldValueCheck,
  locationCheck,
  stabilize,
} from "../../../src/core/recorder/conditions.js";

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
