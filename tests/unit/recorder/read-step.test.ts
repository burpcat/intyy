// Proves the recorder builds a `read_<output>` step from discovery's `read` action line: its
// action, idempotent risk, screen-condition precondition and checkpoint, a target with no
// output-reference clue, the drafted pattern rules, and that a last-step read adds no proof check.
// Also proves `parseLine` and `collectActions` carry output/source/pattern for a read only.
// Design section 6 §14.5 (conditions), §14.7 (outputs), §14.8 (the log); docs/decisions.md, M05.
import { describe, expect, test } from "vitest";
import { collectActions } from "../../../src/core/recorder/collect.js";
import { parseLine } from "../../../src/core/recorder/log-lines.js";
import { buildSteps, type Snapshots } from "../../../src/core/recorder/steps.js";
import { applyTags, keptActions } from "../../../src/core/recorder/tags.js";
import { loadLog } from "./helpers.js";

const RUN = "run_2026-09-24_0000000001";
const NONE: Snapshots = { a11yByTurn: new Map(), proof: null, proofElementListText: null };

type Line = { event: string; data: { fingerprint?: Record<string, unknown> | null } & Record<string, unknown> };

/** The log with the read line's text and pattern changed. `null` text removes nothing. */
function withRead(text: string, pattern: string | null): unknown[] {
  return loadLog("sign_in_then_read.jsonl").map((raw) => {
    const line = raw as Line;
    if (line.event !== "action" || line.data.type !== "read") return raw;
    return {
      ...line,
      data: { ...line.data, pattern, fingerprint: { ...line.data.fingerprint, name: text, text } },
    };
  });
}

function build(lines: unknown[], snapshots: Snapshots = NONE) {
  const kept = keptActions(applyTags(collectActions(RUN, lines), []));
  return buildSteps(kept, snapshots);
}

describe("a read action line becomes a read step", () => {
  test("the last step is read_account_number: idempotent, precondition equals checkpoint", () => {
    const { steps, conditions, targets, issues } = build(loadLog("sign_in_then_read.jsonl"));
    expect(issues).toEqual([]);
    expect(steps.map((s) => s.id)).toEqual([
      "type_user_id",
      "type_password",
      "click_login",
      "read_account_number",
    ]);
    const read = steps[3];
    expect(read).toMatchObject({
      action: { type: "read", source: "text", output: "account_number" },
      risk: "idempotent",
    });
    expect(read?.precondition).toBe(read?.checkpoint);
    // The screen condition: the page's location and the read control visible.
    const byId = new Map(conditions.map((c) => [c.id, c]));
    const cond = byId.get(read?.precondition ?? "");
    expect(cond).toMatchObject({
      check: "all_of",
      checks: [
        { check: "location", pattern: "/main.do" },
        { check: "element_visible" },
      ],
    });
    // A read changes nothing, so it needs no earlier fill's checkpoint.
    expect(JSON.stringify(cond)).not.toContain('"ref"');
    // The read control keeps its role and path, but no output reference as a clue.
    const targetId = (read?.action as { target: string }).target;
    const target = targets.find((t) => t.id === targetId);
    expect(JSON.stringify(target)).not.toContain("{output.");
    expect(target?.clues).not.toHaveProperty("name");
    expect(target?.clues).not.toHaveProperty("text");
  });

  test("the click before it gets the read's screen as its checkpoint", () => {
    const { steps, conditions } = build(loadLog("sign_in_then_read.jsonl"));
    const byId = new Map(conditions.map((c) => [c.id, c]));
    const clickCheck = byId.get(steps[2]?.checkpoint ?? "");
    const readScreen = byId.get(steps[3]?.precondition ?? "");
    // Section 6 §14.5: a click's checkpoint is its landing screen, which is where the read starts.
    expect(clickCheck).toMatchObject({
      check: "all_of",
      checks: [{ check: "location", pattern: "/main.do" }, { check: "element_visible" }],
    });
    expect({ ...clickCheck, id: "x" }).toEqual({ ...readScreen, id: "x" });
  });

  test("a proof on the value just read adds no check, so no no_proof_text issue", () => {
    const { steps, conditions, issues } = build(loadLog("sign_in_then_read.jsonl"), {
      a11yByTurn: new Map(),
      proof: { turn: 4, ids: ["e7"] },
      proofElementListText: 'e7 cell "{output.account_number}"',
    });
    expect(issues.map((i) => i.code)).not.toContain("no_proof_text");
    const read = steps[3];
    expect(read?.checkpoint).toBe(read?.precondition);
    expect(JSON.stringify(conditions.find((c) => c.id === read?.checkpoint))).not.toContain("text_visible");
  });

  test("the same log without the read action line yields no read step", () => {
    const lines = loadLog("sign_in_then_read.jsonl").filter(
      (raw) => !((raw as Line).event === "action" && (raw as Line).data.type === "read"),
    );
    const { steps } = build(lines);
    expect(steps.map((s) => s.id)).toEqual(["type_user_id", "type_password", "click_login"]);
  });
});

describe("a read step's pattern (section 6 §14.7)", () => {
  const patternOf = (lines: unknown[]): unknown => {
    const read = build(lines).steps.find((s) => s.action.type === "read");
    return (read?.action as { pattern?: string }).pattern;
  };

  test("a drafted pattern turns the reference into *", () => {
    expect(patternOf(withRead("Account {output.account_number} opened", null))).toBe("Account * opened");
  });

  test("the LLM's own pattern wins", () => {
    expect(patternOf(withRead("Account {output.account_number} opened", "Account SH* ok"))).toBe(
      "Account SH* ok",
    );
  });

  test("text that is only the reference gets no pattern", () => {
    expect(patternOf(withRead("{output.account_number}", null))).toBeUndefined();
  });
});

describe("log lines carry a read's output, source, and pattern", () => {
  test("parseLine accepts tool read with output, source, and pattern", () => {
    const raw = loadLog("sign_in_then_read.jsonl").find(
      (l) => (l as Line).event === "action" && (l as Line).data.type === "read",
    );
    const line = parseLine({ ...(raw as object), data: { ...(raw as Line).data, pattern: "A *" } });
    expect(line).toMatchObject({
      event: "action",
      data: { type: "read", output: "account_number", source: "text", pattern: "A *", dispatched: false },
    });
  });

  test("parseLine rejects an unknown source", () => {
    const raw = loadLog("sign_in_then_read.jsonl").find(
      (l) => (l as Line).event === "action" && (l as Line).data.type === "read",
    ) as Line;
    expect(() => parseLine({ ...raw, data: { ...raw.data, source: "html" } })).toThrow();
  });

  test("collectActions returns them for a read, and null for other tools", () => {
    const actions = collectActions(RUN, loadLog("sign_in_then_read.jsonl"));
    expect(actions.map((a) => a.tool)).toEqual(["type", "type", "click", "read"]);
    expect(actions[3]).toMatchObject({ output: "account_number", source: "text", pattern: null });
    for (const a of actions.slice(0, 3)) {
      expect(a).toMatchObject({ output: null, source: null, pattern: null });
    }
  });
});
