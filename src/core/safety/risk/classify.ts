// The risk classifier: puts every action in a risk class, the same way every time.
// Follows design section 4 §7.1 (classes), §7.2 (base class by action type), §7.3 (words),
// §7.4 (roles), §7.5 (context rules C1 to C3), and §7.6 (the final class and the unsure rule).
import type { RoleGroup } from "../../../ports/surface.js";
import type { EffectivePolicy } from "../policy/merge.js";

/** A risk class (section 4 §7.1). "Unsure" is not a class; it is a reason, treated as irreversible. */
export type RiskClass = "idempotent" | "reversible" | "irreversible";

/** Which rule decided the class. Logged beside the class. */
export type RiskReason =
  | "base"
  | "irreversible_word"
  | "reversible_word"
  | "safe_word"
  | "navigation_role"
  | "irreversible_path"
  | "c1_money_form"
  | "c2_irreversible_page"
  | "unsure";

/** The classifier's answer. `unsure` is true only with class `irreversible` (rule `risk.unsure`). */
export type RiskVerdict = { risk: RiskClass; unsure: boolean; reason: RiskReason };

/** The word lists and key mapping from the merged policy. */
export type RiskWords = EffectivePolicy["risk"];

/**
 * A control, as the risk rules see it. `words` come from four places: accessible name,
 * visible text, button value, and tooltip (section 4 §7.3). Empty places may be left out.
 */
export type RiskControl = { role: string; roleGroup: RoleGroup; words: readonly string[] };

/** A click, with the context rules' facts (section 4 §7.5). */
export type ClickInput = {
  type: "click";
  control: RiskControl;
  /** For a link with a plain address: what the allowlist says of its target. Else null. */
  link: { allowed: boolean; irreversible: boolean } | null;
  /** C2: the current page is on the app's `irreversible` list. */
  pageIrreversible: boolean;
  /** C1: the control submits a form that holds a `financial` input or a money value. */
  submitsMoneyForm: boolean;
  /** C3: set when this click accepts a native box. Its message is the only label read (may be empty). */
  dialogMessage: string | null;
};

/** A key press. `submit` is the form's submit control, for Enter (section 4 §7.2). */
export type PressInput = { type: "press"; key: string; submit: ClickInput | null };

/** Anything the classifier can class. */
export type RiskInput =
  | { type: "read" | "scroll" | "type" | "select" | "set_checked" }
  | { type: "navigate"; irreversiblePath: boolean }
  | PressInput
  | ClickInput;

/** Characters that join a word: letters, digits, `'`, `/`, `-`. Examples: `mother's`, `a/c`, `e-mail`. */
const NOT_WORD = /[^\p{L}\p{N}'/-]+/u;

/**
 * Normalizes control words (section 4 §7.3): lower case, trimmed, spaces collapsed,
 * symbols like `»` and `...` removed. Example: `"  Look  Up...  "` becomes `"look up"`.
 */
export function normalizeWords(text: string): string {
  return text
    .toLowerCase()
    .split(NOT_WORD)
    .map((token) => token.replace(/^['/-]+|['/-]+$/g, ""))
    .filter((token) => token !== "")
    .join(" ");
}

/** True when `phrase` appears as a whole-word run. "post" matches "post entry", not "poster". */
function hasPhrase(normalized: string, phrase: string): boolean {
  return ` ${normalized} `.includes(` ${normalizeWords(phrase)} `);
}

/** The strictest list any text hits, or null (section 4 §7.6 steps 1 to 3). */
function wordClass(
  texts: readonly string[],
  words: RiskWords,
): "irreversible" | "reversible" | "safe" | null {
  const all = texts.map(normalizeWords).filter((t) => t !== "");
  const hits = (list: readonly string[]): boolean =>
    all.some((t) => list.some((phrase) => hasPhrase(t, phrase)));
  if (hits(words.irreversible_words)) return "irreversible";
  if (hits(words.reversible_words)) return "reversible";
  if (hits(words.safe_words)) return "safe";
  return null;
}

/** Roles that count as navigation-like for risk (section 4 §7.4). */
const NAVIGATION_ROLES = new Set([
  "tab",
  "treeitem",
  "row",
  "cell",
  "gridcell",
  "listitem",
  "option",
]);

/**
 * Navigation-like: tab, tree item, row, cell, list item, option, or a link to a plain allowed
 * path (section 4 §7.4). A link whose target is unknown or off the list is button-like.
 */
function isNavigationLike(c: ClickInput): boolean {
  if (NAVIGATION_ROLES.has(c.control.role)) return true;
  return c.control.roleGroup === "navigation" && c.link?.allowed === true;
}

const verdict = (risk: RiskClass, reason: RiskReason): RiskVerdict => ({
  risk,
  unsure: false,
  reason,
});

const UNSURE: RiskVerdict = { risk: "irreversible", unsure: true, reason: "unsure" };

/** Classes a click: words, context rules, then roles (section 4 §7.3 to §7.6). */
function classifyClick(c: ClickInput, words: RiskWords): RiskVerdict {
  // Why: section 4 §7.5 C3, the message words are the label. The Accept button's own "OK" is
  // a safe word, so it must not count: a box with no list word is unsure, so irreversible.
  const texts = c.dialogMessage === null ? c.control.words : [c.dialogMessage];
  const hit = wordClass(texts, words);
  // Why: owner decision 2026-09-30, a safe word in a box's message ("open", "view") proves
  // nothing about what OK does. Only irreversible and reversible words count there.
  const found = c.dialogMessage !== null && hit === "safe" ? null : hit;
  const navigationLike = c.dialogMessage === null && isNavigationLike(c);

  // Why: section 4 §7.6 step 1, an irreversible word or any context rule wins.
  if (found === "irreversible") return verdict("irreversible", "irreversible_word");
  if (c.link?.irreversible === true) return verdict("irreversible", "irreversible_path");
  if (c.submitsMoneyForm) return verdict("irreversible", "c1_money_form");
  if (c.pageIrreversible && !navigationLike) return verdict("irreversible", "c2_irreversible_page");

  if (found === "reversible") return verdict("reversible", "reversible_word");
  if (found === "safe") return verdict("idempotent", "safe_word");
  if (navigationLike) return verdict("idempotent", "navigation_role");
  return UNSURE;
}

/** Keys that move focus or scroll, and change nothing (section 4 §7.2). */
const QUIET_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
]);

/** Classes a key press (section 4 §7.2). An unknown key is unsure. */
function classifyPress(p: PressInput, words: RiskWords): RiskVerdict {
  if (QUIET_KEYS.has(p.key)) return verdict("idempotent", "base");
  if (p.key === "Escape") return verdict("reversible", "base");
  if (p.key === "Enter") return p.submit === null ? UNSURE : classifyClick(p.submit, words);
  const label = words.key_labels[p.key];
  if (label === undefined) return UNSURE;
  // Why: section 4 §6.9, a mapped key is classed like a button with that label.
  return classifyClick(
    {
      type: "click",
      control: { role: "button", roleGroup: "button_like", words: [label] },
      link: null,
      pageIrreversible: false,
      submitsMoneyForm: false,
      dialogMessage: null,
    },
    words,
  );
}

/**
 * Classes one action (section 4 §7). Context rules only raise a class. The strictest answer
 * wins, and anything the rules cannot place is unsure, so treated as irreversible (§2.3).
 */
export function classify(input: RiskInput, words: RiskWords): RiskVerdict {
  switch (input.type) {
    case "read":
    case "scroll":
    case "type":
    case "select":
    case "set_checked":
      return verdict("idempotent", "base");
    case "navigate":
      return input.irreversiblePath
        ? verdict("irreversible", "irreversible_path")
        : verdict("idempotent", "base");
    case "press":
      return classifyPress(input, words);
    case "click":
      return classifyClick(input, words);
  }
}
