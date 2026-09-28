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
  test("member search, click Search: safe word", () => {
    expect(classify(button("Search"), words)).toEqual({
      risk: "idempotent",
      unsure: false,
      reason: "safe_word",
    });
  });

  test("search results, click a row: navigation-like role", () => {
    const row = button("{input.member_id} [name#1]", {
      control: { role: "row", roleGroup: "container", words: ["{input.member_id} [name#1]"] },
    });
    expect(classify(row, words)).toEqual({
      risk: "idempotent",
      unsure: false,
      reason: "navigation_role",
    });
  });

  test('member page, click "Open New Account": open is safe, no risky phrase', () => {
    expect(cls(button("Open New Account"))).toBe("idempotent");
  });

  test('account form, click "Confirm": irreversible word', () => {
    expect(classify(button("Confirm"), words).reason).toBe("irreversible_word");
    expect(cls(button("Confirm"))).toBe("irreversible");
  });

  test('account form with a deposit typed, click "Next": C1', () => {
    expect(classify(button("Next", { submitsMoneyForm: true }), words)).toEqual({
      risk: "irreversible",
      unsure: false,
      reason: "c1_money_form",
    });
  });

  test('info box, click "OK": button-like with no list word is unsure', () => {
    expect(classify(button("OK"), words)).toEqual({
      risk: "irreversible",
      unsure: true,
      reason: "unsure",
    });
  });

  test('script box "Transfer $100?", accept: C3 reads the message', () => {
    expect(classify(button("OK", { dialogMessage: "Transfer $100?" }), words)).toEqual({
      risk: "irreversible",
      unsure: false,
      reason: "irreversible_word",
    });
  });

  test("old terminal app, press F10 with no mapping: unsure here; the allowlist blocks it", () => {
    expect(classify({ type: "press", key: "F10", submit: null }, words).unsure).toBe(true);
  });

  test("member page, link to an irreversible path: C2 path", () => {
    const link = button("Close", {
      control: { role: "link", roleGroup: "navigation", words: ["Close"] },
      link: { allowed: true, irreversible: true },
    });
    expect(classify(link, words)).toEqual({
      risk: "irreversible",
      unsure: false,
      reason: "irreversible_path",
    });
  });

  test('nominee form, click "Add Row": reversible word', () => {
    expect(classify(button("Add Row"), words)).toEqual({
      risk: "reversible",
      unsure: false,
      reason: "reversible_word",
    });
  });
});

describe("words (section 4 §7.3)", () => {
  test("normalizing: lower case, trimmed, spaces collapsed, symbols removed", () => {
    expect(normalizeWords("  Search  »  ")).toBe("search");
    expect(normalizeWords("Look\n  Up...")).toBe("look up");
    expect(normalizeWords("'Confirm'!")).toBe("confirm");
    expect(normalizeWords("A/C No: 5")).toBe("a/c no 5");
  });

  test("whole words only", () => {
    expect(cls(button("Post Entry"))).toBe("irreversible");
    expect(classify(button("Poster"), words).unsure).toBe(true);
    expect(classify(button("Searching"), words).unsure).toBe(true);
  });

  test("phrases match as whole-word runs", () => {
    expect(cls(button("Close Account"))).toBe("irreversible");
    expect(cls(button("Close"))).toBe("idempotent");
    expect(cls(button("Log Out"))).toBe("reversible");
  });

  test("the strictest word wins", () => {
    expect(cls(button("Search and Delete"))).toBe("irreversible");
    expect(cls(button("Confirm Search"))).toBe("irreversible");
    expect(cls(button("Add and View"))).toBe("reversible");
  });

  test("the four word places all count", () => {
    const b = button("Go", {
      control: { role: "button", roleGroup: "button_like", words: ["Go", "", "Submit", "Search"] },
    });
    expect(cls(b)).toBe("irreversible");
  });

  test("bland labels fall to unsure", () => {
    for (const label of ["OK", "Yes", "Continue", "Proceed", "Go", "Next", "Done", "Cancel"]) {
      expect(classify(button(label), words), label).toEqual({
        risk: "irreversible",
        unsure: true,
        reason: "unsure",
      });
    }
  });

  test("a policy word the lists add is used", () => {
    const more = { ...words, safe_words: [...words.safe_words, "enquiry"] };
    expect(classify(button("Enquiry"), more).risk).toBe("idempotent");
  });
});

describe("roles (section 4 §7.4)", () => {
  test("a script link is button-like, so a bland label is unsure", () => {
    const script = button("Proceed", {
      control: { role: "link", roleGroup: "button_like", words: ["Proceed"] },
    });
    expect(classify(script, words).unsure).toBe(true);
  });

  test("an icon with no name is button-like with no words: unsure", () => {
    const icon = button("", { control: { role: "img", roleGroup: "button_like", words: [] } });
    expect(classify(icon, words).unsure).toBe(true);
  });

  test("tabs, tree items, cells, list items, and options are navigation-like", () => {
    for (const role of ["tab", "treeitem", "cell", "gridcell", "listitem", "option"]) {
      const c = button("Jan", { control: { role, roleGroup: "container", words: ["Jan"] } });
      expect(cls(c), role).toBe("idempotent");
    }
  });

  test("a link to a plain allowed path is navigation-like", () => {
    const link = button("Members", {
      control: { role: "link", roleGroup: "navigation", words: ["Members"] },
      link: { allowed: true, irreversible: false },
    });
    expect(classify(link, words).reason).toBe("navigation_role");
  });

  test("a link off the allowlist is not navigation-like: unsure", () => {
    const link = button("NCUA", {
      control: { role: "link", roleGroup: "navigation", words: ["NCUA"] },
      link: { allowed: false, irreversible: false },
    });
    expect(classify(link, words).unsure).toBe(true);
  });

  test("a list word still beats a navigation role", () => {
    const row = button("Delete", {
      control: { role: "row", roleGroup: "container", words: ["Delete"] },
    });
    expect(cls(row)).toBe("irreversible");
  });
});

describe("context rules only raise (section 4 §7.5)", () => {
  test("C1 raises a safe word", () => {
    expect(cls(button("Search", { submitsMoneyForm: true }))).toBe("irreversible");
  });

  test("C2: a button-like control on an irreversible page", () => {
    expect(cls(button("Search", { pageIrreversible: true }))).toBe("irreversible");
    expect(classify(button("Search", { pageIrreversible: true }), words).reason).toBe(
      "c2_irreversible_page",
    );
  });

  test("C2 leaves navigation-like controls alone", () => {
    const tab = button("Notes", {
      control: { role: "tab", roleGroup: "navigation", words: ["Notes"] },
      pageIrreversible: true,
    });
    expect(cls(tab)).toBe("idempotent");
  });

  test("C3: a message with no list word is unsure", () => {
    expect(classify(button("OK", { dialogMessage: "Session will expire" }), words).unsure).toBe(
      true,
    );
  });

  test("C3: a safe message keeps its class", () => {
    expect(cls(button("OK", { dialogMessage: "Show the details?" }))).toBe("idempotent");
  });
});

describe("base class by action type (section 4 §7.2)", () => {
  test("read, scroll, type, select, set_checked are idempotent", () => {
    for (const type of ["read", "scroll", "type", "select", "set_checked"] as const) {
      expect(classify({ type }, words), type).toEqual({
        risk: "idempotent",
        unsure: false,
        reason: "base",
      });
    }
  });

  test("navigate is idempotent unless the path is irreversible", () => {
    expect(cls({ type: "navigate", irreversiblePath: false })).toBe("idempotent");
    expect(classify({ type: "navigate", irreversiblePath: true }, words).reason).toBe(
      "irreversible_path",
    );
  });

  test("press Tab, arrows, and page keys are idempotent; Escape is reversible", () => {
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
  });

  test("press Enter is classed like the form's submit control", () => {
    expect(cls({ type: "press", key: "Enter", submit: button("Search") })).toBe("idempotent");
    expect(
      cls({ type: "press", key: "Enter", submit: button("Search", { submitsMoneyForm: true }) }),
    ).toBe("irreversible");
    expect(classify({ type: "press", key: "Enter", submit: null }, words).unsure).toBe(true);
  });

  test("a mapped function key is classed like a button with that label", () => {
    expect(cls({ type: "press", key: "F2", submit: null })).toBe("idempotent");
  });
});
