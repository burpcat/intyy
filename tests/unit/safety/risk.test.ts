// Proves the risk classifier: every row of section 4 §7.12, plus word, role, and context cases.
// Design section 4 §7.1 to §7.6; section 4 §14, "Risk classifier"; M02 task 3.
import { describe, expect, test } from "vitest";
import {
  classify,
  normalizeWords,
  type ClickInput,
  type RiskInput,
  type RiskWords,
} from "../../../src/core/safety/risk/classify.js";

/** The global default lists (section 4 §7.3), as the approved global policy holds them. */
const words: RiskWords = {
  irreversible_words: [
    "confirm",
    "submit",
    "transfer",
    "pay",
    "send",
    "delete",
    "remove",
    "approve",
    "authorize",
    "authorise",
    "post",
    "commit",
    "execute",
    "process",
    "finalize",
    "finalise",
    "disburse",
    "withdraw",
    "deposit",
    "credit",
    "debit",
    "reverse",
    "void",
    "save",
    "update",
    "apply",
    "sanction",
    "release",
    "block",
    "unblock",
    "freeze",
    "activate",
    "deactivate",
    "close account",
    "open account",
  ],
  reversible_words: [
    "add",
    "append",
    "insert",
    "attach",
    "duplicate",
    "logout",
    "log out",
    "sign out",
  ],
  safe_words: [
    "search",
    "find",
    "look up",
    "lookup",
    "view",
    "show",
    "display",
    "details",
    "open",
    "back",
    "previous",
    "close",
    "refresh",
    "expand",
    "collapse",
    "sort",
    "filter",
    "help",
    "home",
    "menu",
    "login",
    "log in",
    "sign in",
    "list",
    "get",
  ],
  key_labels: { F2: "search" },
};

/** A click on a button with these words, and no context. */
function button(label: string, extra: Partial<ClickInput> = {}): ClickInput {
  return {
    type: "click",
    control: { role: "button", roleGroup: "button_like", words: [label] },
    link: null,
    pageIrreversible: false,
    submitsMoneyForm: false,
    dialogMessage: null,
    ...extra,
  };
}

/** The class only. */
const cls = (input: RiskInput): string => classify(input, words).risk;

describe("section 4 §7.12 worked examples", () => {
  test("every worked example gets the class the design table gives it", () => {
    expect(classify(button("Search"), words)).toEqual({
      risk: "idempotent",
      unsure: false,
      reason: "safe_word",
    });
    const row = button("{input.member_id} [name#1]", {
      control: { role: "row", roleGroup: "container", words: ["{input.member_id} [name#1]"] },
    });
    expect(classify(row, words)).toEqual({
      risk: "idempotent",
      unsure: false,
      reason: "navigation_role",
    });
    expect(cls(button("Open New Account"))).toBe("idempotent");
    expect(classify(button("Confirm"), words).reason).toBe("irreversible_word");
    expect(cls(button("Confirm"))).toBe("irreversible");
    expect(classify(button("Next", { submitsMoneyForm: true }), words)).toEqual({
      risk: "irreversible",
      unsure: false,
      reason: "c1_money_form",
    });
    expect(classify(button("OK"), words)).toEqual({
      risk: "irreversible",
      unsure: true,
      reason: "unsure",
    });
    expect(classify(button("OK", { dialogMessage: "Transfer $100?" }), words)).toEqual({
      risk: "irreversible",
      unsure: false,
      reason: "irreversible_word",
    });
    expect(classify({ type: "press", key: "F10", submit: null }, words).unsure).toBe(true);
    const link = button("Close", {
      control: { role: "link", roleGroup: "navigation", words: ["Close"] },
      link: { allowed: true, irreversible: true },
    });
    expect(classify(link, words)).toEqual({
      risk: "irreversible",
      unsure: false,
      reason: "irreversible_path",
    });
    expect(classify(button("Add Row"), words)).toEqual({
      risk: "reversible",
      unsure: false,
      reason: "reversible_word",
    });
  });

});

describe("words (section 4 §7.3)", () => {
  test("words: normalizing, whole words, phrases, strictest wins, bland labels, policy additions", () => {
    expect(normalizeWords("  Search  »  ")).toBe("search");
    expect(normalizeWords("Look\n  Up...")).toBe("look up");
    expect(normalizeWords("'Confirm'!")).toBe("confirm");
    expect(normalizeWords("A/C No: 5")).toBe("a/c no 5");
    expect(cls(button("Post Entry"))).toBe("irreversible");
    expect(classify(button("Poster"), words).unsure).toBe(true);
    expect(classify(button("Searching"), words).unsure).toBe(true);
    expect(cls(button("Close Account"))).toBe("irreversible");
    expect(cls(button("Close"))).toBe("idempotent");
    expect(cls(button("Log Out"))).toBe("reversible");
    expect(cls(button("Search and Delete"))).toBe("irreversible");
    expect(cls(button("Confirm Search"))).toBe("irreversible");
    expect(cls(button("Add and View"))).toBe("reversible");
    const b = button("Go", {
      control: { role: "button", roleGroup: "button_like", words: ["Go", "", "Submit", "Search"] },
    });
    expect(cls(b)).toBe("irreversible");
    for (const label of ["OK", "Yes", "Continue", "Proceed", "Go", "Next", "Done", "Cancel"]) {
      expect(classify(button(label), words), label).toEqual({
        risk: "irreversible",
        unsure: true,
        reason: "unsure",
      });
    }
    const more = { ...words, safe_words: [...words.safe_words, "enquiry"] };
    expect(classify(button("Enquiry"), more).risk).toBe("idempotent");
  });

});

describe("roles (section 4 §7.4)", () => {
  test("roles: script links, icons, navigation-like roles, and links decide the class", () => {
    {
      const script = button("Proceed", {
        control: { role: "link", roleGroup: "button_like", words: ["Proceed"] },
      });
      expect(classify(script, words).unsure).toBe(true);
    }
    {
      const icon = button("", { control: { role: "img", roleGroup: "button_like", words: [] } });
      expect(classify(icon, words).unsure).toBe(true);
    }
    {
      for (const role of ["tab", "treeitem", "cell", "gridcell", "listitem", "option"]) {
        const c = button("Jan", { control: { role, roleGroup: "container", words: ["Jan"] } });
        expect(cls(c), role).toBe("idempotent");
      }
    }
    {
      const link = button("Members", {
        control: { role: "link", roleGroup: "navigation", words: ["Members"] },
        link: { allowed: true, irreversible: false },
      });
      expect(classify(link, words).reason).toBe("navigation_role");
    }
    {
      const link = button("NCUA", {
        control: { role: "link", roleGroup: "navigation", words: ["NCUA"] },
        link: { allowed: false, irreversible: false },
      });
      expect(classify(link, words).unsure).toBe(true);
    }
    {
      const row = button("Delete", {
        control: { role: "row", roleGroup: "container", words: ["Delete"] },
      });
      expect(cls(row)).toBe("irreversible");
    }
  });

});

describe("context rules only raise (section 4 §7.5)", () => {
  test("context rules C1, C2, and C3 only raise the class", () => {
    expect(cls(button("Search", { submitsMoneyForm: true }))).toBe("irreversible");
    expect(cls(button("Search", { pageIrreversible: true }))).toBe("irreversible");
    expect(classify(button("Search", { pageIrreversible: true }), words).reason).toBe(
      "c2_irreversible_page",
    );
    const tab = button("Notes", {
      control: { role: "tab", roleGroup: "navigation", words: ["Notes"] },
      pageIrreversible: true,
    });
    expect(cls(tab)).toBe("idempotent");
    expect(classify(button("OK", { dialogMessage: "Session will expire" }), words).unsure).toBe(
      true,
    );
    const v = classify(button("OK", { dialogMessage: "Show the details?" }), words);
    expect([v.risk, v.unsure]).toEqual(["irreversible", true]);
  });

});

describe("base class by action type (section 4 §7.2)", () => {
  test("base class by action type: idempotent kinds, navigate, keys, Enter, and function keys", () => {
    for (const type of ["read", "scroll", "type", "select", "set_checked"] as const) {
      expect(classify({ type }, words), type).toEqual({
        risk: "idempotent",
        unsure: false,
        reason: "base",
      });
    }
    expect(cls({ type: "navigate", irreversiblePath: false })).toBe("idempotent");
    expect(classify({ type: "navigate", irreversiblePath: true }, words).reason).toBe(
      "irreversible_path",
    );
    for (const key of [
      "Tab",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "PageUp",
      "PageDown",
    ]) {
      expect(cls({ type: "press", key, submit: null }), key).toBe("idempotent");
    }
    expect(cls({ type: "press", key: "Escape", submit: null })).toBe("reversible");
    expect(cls({ type: "press", key: "Enter", submit: button("Search") })).toBe("idempotent");
    expect(
      cls({ type: "press", key: "Enter", submit: button("Search", { submitsMoneyForm: true }) }),
    ).toBe("irreversible");
    expect(classify({ type: "press", key: "Enter", submit: null }, words).unsure).toBe(true);
    expect(cls({ type: "press", key: "F2", submit: null })).toBe("idempotent");
  });

});
