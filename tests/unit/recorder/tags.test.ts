// Proves tags.ts step 2 (section 6 §14.2, §12.1, §12.2): the human tag wins once decided, a
// `correction` drops itself and the turn it corrects, and `exploration` is dropped too.
import { describe, expect, test } from "vitest";
import { collectActions } from "../../../src/core/recorder/collect.js";
import { applyTags, keptActions } from "../../../src/core/recorder/tags.js";
import { loadLog } from "./helpers.js";

const RUN = "run_2026-09-24_0000000003";

describe("applyTags and keptActions", () => {
  test("a correction drops itself and the turn it names; exploration is dropped", () => {
    const actions = collectActions(RUN, loadLog("tag_decisions.jsonl"));
    const tagged = applyTags(actions, []);
    const kept = keptActions(tagged);
    // Turn 1 (share accounts) is corrected by turn 2; turn 2 is itself a correction; turn 3 is
    // exploration. Only turn 4 (open account) stays.
    expect(kept.map((a) => a.turn)).toEqual([4]);
  });

  test("a human tag decision overrides the LLM tag, last one wins", () => {
    const actions = collectActions(RUN, loadLog("tag_decisions.jsonl"));
    const turn3 = actions.find((a) => a.turn === 3);
    if (turn3 === undefined) throw new Error("fixture missing turn 3");
    const subject = `${RUN}#${String(turn3.seq)}`;
    const tagged = applyTags(actions, [
      { what: "tag", subject, value: "flow_step" },
      { what: "tag", subject, value: "exploration" },
      { what: "tag", subject, value: "flow_step" },
    ]);
    const kept = keptActions(tagged);
    expect(kept.map((a) => a.turn)).toEqual([3, 4]);
  });
});
