// Proves replay writes a `target_vote` log line for each target a task step finds (design
// section 3 §6.4 and section 7 §6.8: candidates, winner, score, margin, and the agreeing,
// differing, and missing clue names; build decision of M10 task 3): one line per find, before the
// step's gate line, none for prelude `session:*` steps, a not-found find logs a vote with no
// winner, and the line holds clue names and numbers only, never an input or a screen value.
// Certify's scorer reads these lines for locator margins (section 8 §9.2). M10 task 3.
import { describe, expect, test } from "vitest";
import { votesOf } from "../../../src/core/certify/score.js";
import { runReplay } from "../../../src/core/replay/executor.js";
import {
  ACCOUNT_NUMBER,
  MEMBER_FOUND,
  TENANT,
  authorizationFor,
  buildHarness,
  fixtureSite,
  replayInputOf,
  requestOf,
  type SiteOpts,
} from "./executor-harness.js";

type Line = { seq: number; event: string; step: string | null; by: string; data: Record<string, unknown> };

/** Replays `kvfcu/open_sub@1` on a fixture site and returns the run's log lines. */
async function logOf(site: SiteOpts = {}): Promise<Line[]> {
  const h = await buildHarness(fixtureSite(site));
  const request = requestOf({ authorization: authorizationFor("kvfcu/open_sub@1") });
  const { runId } = await runReplay(replayInputOf(h, request), h.deps);
  const events = await h.deps.evidence.events(TENANT, runId);
  if (!events.ok) throw new Error("no run log");
  return events.value as Line[];
}

const votes = (lines: Line[]): Line[] => lines.filter((l) => l.event === "target_vote");

describe("target_vote lines", () => {
  test("one line per target find, in step order, before that step's gate line", async () => {
    const lines = await logOf();
    expect(votes(lines).map((l) => [l.step, l.data.target])).toEqual([
      ["type_member_id", "member_id_box"],
      ["click_search", "search_button"],
      ["click_confirm", "confirm_button"],
      ["read_account_number", "account_number_display"],
    ]);
    for (const v of votes(lines)) {
      expect(v.by).toBe("engine");
      const gate = lines.find((l) => l.event === "gate" && l.step === v.step);
      if (gate !== undefined) expect(v.seq).toBeLessThan(gate.seq);
    }
  });

  test("prelude steps (session:*) write none", async () => {
    const lines = await logOf();
    expect(lines.some((l) => l.step?.startsWith("session:") === true)).toBe(true);
    expect(votes(lines).filter((l) => l.step?.startsWith("session:") === true)).toEqual([]);
  });

  test("each line holds the vote's facts: counts, winner, score, margin, clue names", async () => {
    const [first] = votes(await logOf());
    expect(Object.keys(first?.data ?? {}).sort()).toEqual([
      "agree", "candidates", "disagree", "margin", "missing", "score", "target", "winner",
    ]);
    expect(first?.data).toMatchObject({ candidates: 1, margin: 1, score: 1, disagree: [], missing: [] });
    expect(first?.data.agree).toEqual(expect.arrayContaining(["label"]));
    expect(typeof first?.data.winner).toBe("string");
  });

  test("the scorer can read what the replay wrote", async () => {
    const samples = votesOf(await logOf());
    expect(samples.map((s) => [s.step, s.target, s.margin, s.score])).toEqual([
      ["type_member_id", "member_id_box", 1, 1],
      ["click_search", "search_button", 1, 1],
      ["click_confirm", "confirm_button", 1, 1],
      ["read_account_number", "account_number_display", 1, 1],
    ]);
  });

  test("a vote line holds no input value and no screen value", async () => {
    const text = votes(await logOf()).map((l) => JSON.stringify(l)).join("\n");
    expect(text).not.toContain(MEMBER_FOUND);
    expect(text).not.toContain(ACCOUNT_NUMBER);
    // Only clue names and numbers: every value is a string name, a number, null, or a list of names.
    for (const v of votes(await logOf())) {
      for (const list of [v.data.agree, v.data.disagree, v.data.missing]) {
        expect(Array.isArray(list) && list.every((c) => typeof c === "string" && /^[a-z_]+$/.test(c))).toBe(true);
      }
    }
  });

  test("a target that is not found logs a vote with no winner, before the step's failed check", async () => {
    const lines = await logOf({ homeMissingSearchButton: true });
    // Why more than one: rung 1 resumes at an earlier step, and each pass runs the step again.
    const search = votes(lines).filter((l) => l.step === "click_search");
    expect(search.length).toBeGreaterThan(0);
    for (const v of search) {
      expect(v.data).toMatchObject({ target: "search_button", candidates: 0, winner: null, score: null, margin: null });
    }
    const check = lines.find((l) => l.event === "check" && l.step === "click_search");
    expect(search[0]?.seq).toBeLessThan(check?.seq ?? 0);
    expect(votes(lines).some((l) => l.step === "click_confirm")).toBe(false);
  });
});
