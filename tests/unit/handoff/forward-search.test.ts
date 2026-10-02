// Proves forward search, the pure part of the handback: it credits the human only for steps their
// own checkpoint proves finished, takes the latest such step, never searches past a `read` step,
// and crosses the commit step only when the commit is `confirmed`. A sent commit step is never a
// resume step (CLAUDE.md, "never retry an irreversible step"). Design section 7 §16.2, §16.3;
// docs/decisions.md, M07. M07 task 4.
import { describe, expect, test } from "vitest";
import { forwardSearch, type ForwardFacts, type HandbackStep } from "../../../src/core/handoff/handback.js";
import type { EvalCtx } from "../../../src/core/targets/evaluate.js";
import type { ScreenElement, ScreenView } from "../../../src/core/targets/screen.js";
import { MEMBER_FOUND, OPEN_SUB } from "../replay/executor-harness.js";

/** The fixture artifact's conditions and targets, with the one input a `field_value` check reads. */
const CTX: EvalCtx = {
  targets: new Map(OPEN_SUB.targets.map((t) => [t.id, t])),
  conditions: new Map(OPEN_SUB.conditions.map((c) => [c.id, c])),
  refs: new Map([["input.member_id", MEMBER_FOUND]]),
};

/** `open_sub`'s four steps: type (0), search (1), confirm (2, the commit), read (3). */
const OPEN_STEPS: HandbackStep[] = OPEN_SUB.steps.map((s) => ({
  id: s.id,
  precondition: s.precondition,
  checkpoint: s.checkpoint,
  isRead: s.action.type === "read",
}));

/** One step, built from condition IDs. */
const step = (id: string, precondition: string, checkpoint: string, isRead = false): HandbackStep => ({
  id,
  precondition,
  checkpoint,
  isRead,
});

/** One page's elements, by the same labels the fixture site gives them. */
const PAGES: Record<string, ScreenElement[]> = {
  "/home": [
    { id: "box", role: "textbox", roleGroup: "text_entry", label: "Member ID", path: "/home", visible: true, enabled: true },
    { id: "search", role: "button", roleGroup: "button_like", name: "Search", text: "Search", path: "/home", visible: true, enabled: true },
  ],
  "/result": [
    { id: "confirm", role: "button", roleGroup: "button_like", name: "Confirm", text: "Confirm", path: "/result", visible: true, enabled: true },
  ],
  "/done": [
    { id: "acct", role: "generic", roleGroup: "container", label: "Account number", text: "SH0000000", path: "/done", visible: true, enabled: true },
  ],
  "/check": [],
};

/** The screen at `path`. `typed` fills the Member ID box, the way a person would. */
function screenAt(path: string, typed = false): ScreenView {
  const elements = (PAGES[path] ?? []).map((e) => (e.id === "box" ? { ...e, fieldValue: typed ? MEMBER_FOUND : "" } : e));
  return { location: path, elements };
}

/** Facts with the defaults of a plain search: stuck at the first step, no commit sent. */
const facts = (f: Partial<ForwardFacts> & Pick<ForwardFacts, "screen">): ForwardFacts => ({
  steps: OPEN_STEPS,
  stuckIndex: 0,
  commitIndex: 2,
  commitConfirmed: false,
  commitSent: false,
  ctx: CTX,
  ...f,
});

describe("what the human is credited for (section 7 §16.2)", () => {
  test("forward search credits the human for qualifying steps, latest first", () => {
    // a later step whose precondition passes, but whose previous checkpoint fails, is not credited
    {
      // Both fills read `home_shown`, so the second one's precondition passes on the home page. But
      // the first one's own checkpoint (`member_found_shown`) does not, so nothing proves it done.
      const steps = [step("fill_a", "home_shown", "member_found_shown"), step("fill_b", "home_shown", "done_shown")];
      const screen = screenAt("/home", true);
      expect(forwardSearch(facts({ steps, commitIndex: null, screen }))).toEqual({ kind: "none" });
    }
    // a fill whose own checkpoint passes is credited
    {
      // On the home page with the box filled: `type_member_id`'s checkpoint passes, so `click_search`
      // (precondition `member_id_entered`) qualifies.
      const screen = screenAt("/home", true);
      expect(forwardSearch(facts({ screen }))).toEqual({ kind: "found", index: 1 });
    }
    // an empty box credits nothing: the first fill is not done
    {
      const screen = screenAt("/home");
      expect(forwardSearch(facts({ screen }))).toEqual({ kind: "none" });
    }
    // the latest qualifying step wins
    {
      const screen = screenAt("/home", true);
      const chain = [
        step("s0", "home_shown", "home_shown"),
        step("s1", "home_shown", "home_shown"),
        step("s2", "home_shown", "home_shown"),
        step("s3", "home_shown", "home_shown"),
      ];
      expect(forwardSearch(facts({ steps: chain, commitIndex: null, screen }))).toEqual({ kind: "found", index: 3 });
      // The last step's precondition fails: the latest one that still qualifies is the one before.
      const shorter = [...chain.slice(0, 3), step("s3", "done_shown", "home_shown")];
      expect(forwardSearch(facts({ steps: shorter, commitIndex: null, screen }))).toEqual({ kind: "found", index: 2 });
    }
  });
});

describe("read steps cap the search (section 7 §16.2, §16.3)", () => {
  test("read steps cap the forward search", () => {
    // the search stops at the first read step: found there, never past it
    {
      const screen = screenAt("/done");
      // A step after the read step would qualify too, but the bot must read the outputs itself.
      const steps = [...OPEN_STEPS, step("after_read", "done_shown", "done_shown")];
      expect(forwardSearch(facts({ steps, commitConfirmed: true, commitSent: true, screen }))).toEqual({
        kind: "found",
        index: 3,
      });
    }
    // a read step whose precondition fails is passed over, and steps past it are not searched
    {
      const screen = screenAt("/home", true);
      const steps = [
        step("s0", "home_shown", "home_shown"),
        step("s1", "home_shown", "home_shown"),
        step("read_out", "done_shown", "done_shown", true),
        step("s3", "home_shown", "home_shown"),
      ];
      // `s3` would qualify, but it lies past the read step. The latest below the cap wins.
      expect(forwardSearch(facts({ steps, commitIndex: null, screen }))).toEqual({ kind: "found", index: 1 });
    }
    // a read step that is the stuck step gives no candidate, and nothing past it is credited
    {
      const screen = screenAt("/done");
      const steps = [...OPEN_STEPS, step("after_read", "done_shown", "done_shown")];
      expect(forwardSearch(facts({ steps, stuckIndex: 3, commitConfirmed: true, commitSent: true, screen }))).toEqual({
        kind: "none",
      });
    }
  });
});

describe("crossing the commit step (section 7 §16.2)", () => {
  test("forward search crosses the commit step only when it is confirmed", () => {
    // stuck before the commit and the commit not confirmed: a step past the commit is skipped
    {
      const screen = screenAt("/done");
      // `read_account_number` qualifies on the done page, but the commit is not confirmed.
      expect(forwardSearch(facts({ screen }))).toEqual({ kind: "none" });
    }
    // stuck before the commit and the commit confirmed: a step past the commit is allowed
    {
      const screen = screenAt("/done");
      expect(forwardSearch(facts({ commitConfirmed: true, commitSent: true, screen }))).toEqual({
        kind: "found",
        index: 3,
      });
    }
    // a step before the commit step may still resume the search while the commit is not sent
    {
      // The result page: Confirm shows, so the commit step itself qualifies. It is the latest K and
      // it does not cross the commit point; sending it is the bot's own commit, which has not gone.
      const screen = screenAt("/result");
      expect(forwardSearch(facts({ screen }))).toEqual({ kind: "found", index: 2 });
    }
  });
});

describe("guard: a sent commit is never a resume step (CLAUDE.md, section 7 §16.1)", () => {
  test("a sent commit is never a resume step", () => {
    // sent but not confirmed: nothing at or before the commit step is found, though Confirm still shows
    {
      const screen = screenAt("/result");
      // The same screen resumes at the commit when it is not sent (see above). Sent, it must not.
      expect(forwardSearch(facts({ commitSent: true, screen }))).toEqual({ kind: "none" });
    }
    // sent and confirmed: a step at or before the commit is skipped even if it would qualify
    {
      // No read step, so "past the outputs" cannot answer: the only answer left is "none".
      const steps = OPEN_STEPS.slice(0, 3);
      const sent = { steps, commitSent: true, commitConfirmed: true };
      // Confirm still shows: the commit step's own precondition and the search checkpoint pass.
      expect(forwardSearch(facts({ ...sent, screen: screenAt("/result") }))).toEqual({ kind: "none" });
      // The box is filled and `click_search` qualifies, but it lies before the commit.
      expect(forwardSearch(facts({ ...sent, screen: screenAt("/home", true) }))).toEqual({ kind: "none" });
    }
  });
});

describe("the human moved past the outputs (section 7 §16.3)", () => {
  /** A page that is none of the fixture's: no condition holds on it. */
  const elsewhere = (): ScreenView => screenAt("/check");

  test("past the outputs needs a confirmed commit and a failing read precondition", () => {
    // the commit is confirmed, the first read step is after it, and its precondition fails
    {
      const screen = elsewhere();
      expect(forwardSearch(facts({ commitConfirmed: true, commitSent: true, screen }))).toEqual({ kind: "past_outputs" });
    }
    // the read step's precondition still passes: the bot reads it, so not past the outputs
    {
      const screen = screenAt("/done");
      expect(forwardSearch(facts({ commitConfirmed: true, commitSent: true, screen }))).not.toEqual({
        kind: "past_outputs",
      });
    }
    // the commit is not confirmed: never past the outputs
    {
      const screen = elsewhere();
      expect(forwardSearch(facts({ commitSent: true, screen }))).toEqual({ kind: "none" });
    }
    // no read step at all: never past the outputs
    {
      const screen = elsewhere();
      const steps = OPEN_STEPS.slice(0, 3);
      expect(forwardSearch(facts({ steps, commitConfirmed: true, commitSent: true, screen }))).toEqual({ kind: "none" });
    }
  });
});
