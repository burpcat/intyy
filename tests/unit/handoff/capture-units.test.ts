// Proves the pure parts of human capture: which control paths belong to the bot (`pathMatches`),
// the bot's 300 ms window (`BotWindows`), the 0.70 commit-click score (`meetsCommitTarget`), and
// how typed text is masked (`Redactor.humanText`). Design section 7 §14.2 to §14.4; section 4 §8.10.
// M07 task 3.
import { describe, expect, test } from "vitest";
import { BOT_WINDOW_AFTER_MS, BotWindows, meetsCommitTarget, pathMatches } from "../../../src/core/handoff/capture.js";
import type { Target } from "../../../src/core/model/artifact/targets.js";
import { Redactor } from "../../../src/core/safety/redaction/redactor.js";
import type { ElementFingerprint } from "../../../src/ports/surface.js";
import { RULES } from "../discovery/kit.js";

describe("pathMatches (section 7 §14.3: on the bot's target)", () => {
  test("pathMatches matches the same path, a path inside, and null on either side", () => {
    // the same path, or a path inside the target, is a match
    {
      expect(pathMatches("form > button", "form > button")).toBe(true);
      expect(pathMatches("form > button", "form > button > span")).toBe(true);
      // The other way: the page script may report the outer control for a click on inner text.
      expect(pathMatches("form > button > span", "form > button")).toBe(true);
    }
    // a sibling, a different control, or a lookalike prefix is not
    {
      expect(pathMatches("form > button", "form > link")).toBe(false);
      expect(pathMatches("form > button", "form > buttons")).toBe(false);
      expect(pathMatches("form > button", "nav > button")).toBe(false);
    }
    // null on either side matches anything
    {
      expect(pathMatches(null, "form > button")).toBe(true);
      expect(pathMatches("form > button", null)).toBe(true);
      expect(pathMatches(null, null)).toBe(true);
    }
  });
});

describe("BotWindows (section 7 §14.3: from just before the action until 300 ms after)", () => {
  /** A windows object on a clock the test sets. */
  function windows(): { w: BotWindows; set: (ms: number) => void } {
    let now = 0;
    return { w: new BotWindows(() => now), set: (ms) => (now = ms) };
  }
  const T0 = 10_000;

  test("BotWindows owns events from the start to end + 299, open windows, null paths, and earlier windows", () => {
    // events at the start and up to end + 299 are the bot's
    {
      const { w, set } = windows();
      set(T0);
      w.begin("form > button");
      set(T0 + 50);
      w.end();
      expect(w.owns(T0, "form > button")).toBe(true);
      expect(w.owns(T0 + 25, "form > button")).toBe(true);
      expect(w.owns(T0 + 50 + 299, "form > button")).toBe(true);
      expect(BOT_WINDOW_AFTER_MS).toBe(300);
    }
    // an event at end + 301, before the start, or on another path is a person's
    {
      const { w, set } = windows();
      set(T0);
      w.begin("form > button");
      set(T0 + 50);
      w.end();
      expect(w.owns(T0 + 50 + 301, "form > button")).toBe(false);
      expect(w.owns(T0 - 1, "form > button")).toBe(false);
      expect(w.owns(T0 + 10, "form > link")).toBe(false);
    }
    // while the action runs (no end yet) the window is open
    {
      const { w, set } = windows();
      set(T0);
      w.begin("form > button");
      expect(w.owns(T0 + 5_000, "form > button")).toBe(true);
    }
    // an action with no target (null path) owns every input in its window
    {
      const { w, set } = windows();
      set(T0);
      w.begin(null);
      set(T0 + 10);
      w.end();
      expect(w.owns(T0 + 100, "anything > at all")).toBe(true);
      expect(w.owns(T0 + 10 + 301, "anything > at all")).toBe(false);
    }
    // an earlier window still counts after a later one closes (a type reports at a later blur)
    {
      const { w, set } = windows();
      set(T0);
      w.begin("form > input");
      set(T0 + 20);
      w.end();
      set(T0 + 1_000);
      w.begin("form > button");
      set(T0 + 1_020);
      w.end();
      // The type's own time is the last keystroke, inside the first window.
      expect(w.owns(T0 + 10, "form > input")).toBe(true);
    }
  });
});

describe("meetsCommitTarget (section 7 §14.4: score 0.70 or more)", () => {
  const VIEW = { width: 1000, height: 800 };
  /** Name 0.30, label 0.25, text 0.20 of weight, so the score is the share that agrees. */
  const target: Target = {
    id: "confirm_button",
    description: "Confirm",
    clues: { role: "button", name: "Confirm", label: "Transfer form", text: "Confirm transfer" },
  };
  const fp = (clues: { name?: string; label?: string; text?: string }, extra: Partial<ElementFingerprint> = {}): ElementFingerprint => ({
    role: "button",
    roleGroup: "button_like",
    clues: { path: "form > button", ...clues },
    box: null,
    ...extra,
  });
  const ALL = { name: "Confirm", label: "Transfer form", text: "Confirm transfer" };

  test("meetsCommitTarget hits at 0.70 or more, per role group, within, input clues, and regions", () => {
    // every clue agrees: 1.0, a hit
    {
      expect(meetsCommitTarget(target, fp(ALL), VIEW, undefined)).toBe(true);
    }
    // 0.733 (text differs: 0.55 of 0.75) is a hit; 0.667 (label differs: 0.5 of 0.75) is not
    {
      expect(meetsCommitTarget(target, fp({ ...ALL, text: "Cancel" }), VIEW, undefined)).toBe(true);
      expect(meetsCommitTarget(target, fp({ ...ALL, label: "Other form" }), VIEW, undefined)).toBe(false);
    }
    // a different name is not a hit
    {
      expect(meetsCommitTarget(target, fp({ ...ALL, name: "Cancel" }), VIEW, undefined)).toBe(false);
    }
    // a control of another role group never counts, even with the same words
    {
      expect(meetsCommitTarget(target, fp(ALL, { role: "link", roleGroup: "navigation" }), VIEW, undefined)).toBe(false);
    }
    // `within` is dropped: the control is scored on its own clues
    {
      expect(meetsCommitTarget({ ...target, within: "result_panel" }, fp(ALL), VIEW, undefined)).toBe(true);
    }
    // an {input.*} clue resolves against the run's inputs
    {
      const withRef: Target = { ...target, clues: { role: "button", name: "Open {input.kind}" } };
      const refs = new Map([["input.kind", "savings"]]);
      expect(meetsCommitTarget(withRef, fp({ name: "Open savings" }), VIEW, refs)).toBe(true);
      expect(meetsCommitTarget(withRef, fp({ name: "Open checking" }), VIEW, refs)).toBe(false);
    }
    // a region clue is compared in fractions of the viewport
    {
      const placed: Target = { ...target, clues: { role: "button", name: "Confirm", region: { x: 0.5, y: 0.5, w: 0.1, h: 0.05 } } };
      const near = fp({ name: "Confirm" }, { box: { x: 500, y: 400, width: 100, height: 40 } });
      expect(meetsCommitTarget(placed, near, VIEW, undefined)).toBe(true);
    }
  });
});

describe("Redactor.humanText (section 4 §8.10, section 7 §14.2)", () => {
  /** A redactor that knows member ID `700114` and a short note `ab1`. */
  function redactor(): Redactor {
    const r = new Redactor(RULES);
    r.addKnown({ ref: "input.member_id", value: "700114", label: "pii", type: "text", kind: "member" });
    r.addKnown({ ref: "input.tag", value: "ab1", label: "none", type: "text", kind: "name" });
    return r;
  }

  test("Redactor.humanText gives [secret], an input reference, or [human_text]", () => {
    // a password field (no value read) is [secret]
    {
      expect(String(redactor().humanText(null))).toBe("[secret]");
    }
    // a value equal to a known input is that input's reference
    {
      expect(String(redactor().humanText("700114"))).toBe("{input.member_id}");
      expect(String(redactor().humanText(" 700114 "))).toBe("{input.member_id}");
    }
    // any other text is [human_text], never the text
    {
      expect(String(redactor().humanText("TOPSECRET99"))).toBe("[human_text]");
      expect(String(redactor().humanText("hello"))).toBe("[human_text]");
    }
    // a short known value cannot name one input: [human_text]
    {
      expect(String(redactor().humanText("ab1"))).toBe("[human_text]");
    }
    // two inputs that share a value are ambiguous: [human_text]
    {
      const r = new Redactor(RULES);
      r.addKnown({ ref: "input.first", value: "same-value", label: "none", type: "text", kind: "name" });
      r.addKnown({ ref: "input.second", value: "same-value", label: "none", type: "text", kind: "name" });
      expect(String(r.humanText("same-value"))).toBe("[human_text]");
    }
    // a part of a known input is not the input
    {
      expect(String(redactor().humanText("70011"))).toBe("[human_text]");
    }
  });
});
