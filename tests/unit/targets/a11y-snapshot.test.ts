// Proves fromA11ySnapshot (docs/formats/a11y-snapshot.md): roles, names, flags, and nesting
// become a ScreenView, with no boxes or field values.
import { describe, expect, test } from "vitest";
import { fromA11ySnapshot } from "../../../src/core/targets/a11y-snapshot.js";

describe("fromA11ySnapshot", () => {
  test("the doc's own example: a form, a link, a frame, and a checked checkbox", () => {
    const text = [
      '- form "Member ID Password Search":',
      '  - textbox "Member ID"',
      '  - textbox "Password"',
      '  - button "Search"',
      '- link "Members":',
      "  - /url: http://127.0.0.1:8080/members",
      '- iframe "help":',
      '  - button "Help"',
      '- checkbox "Joint" [checked]',
    ].join("\n");
    const v = fromA11ySnapshot(text, "/members");
    expect(v.location).toBe("/members");
    const byName = new Map(v.elements.map((e) => [e.name, e]));
    expect(byName.get("Search")).toMatchObject({ role: "button" });
    expect(byName.get("Joint")).toMatchObject({ role: "checkbox", checked: true });
    // The /url line is skipped: it holds an address, not user-visible text.
    expect(v.elements.some((e) => e.role === "/url")).toBe(false);
    const search = byName.get("Search");
    const form = v.elements.find((e) => e.role === "form");
    expect(search?.parent).toBe(form?.id);
  });

  test("a text-only line and a disabled control", () => {
    const text = '- text: Welcome back\n- button "Confirm" [disabled]';
    const v = fromA11ySnapshot(text, "/home");
    expect(v.elements[0]).toMatchObject({ role: "text", text: "Welcome back" });
    expect(v.elements[1]).toMatchObject({ role: "button", name: "Confirm", enabled: false });
  });
});
