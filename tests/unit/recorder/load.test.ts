// Proves loadSnapshots reads the proof turn's element-list text in either shape the recorder
// may meet (design section 6 §14.5, section 9 §5.3): the real Claude adapter's own wire body
// (`messages[0].content`, one text block), or a fake planner's flat `PlannerTurn` JSON (a
// top-level `message` string). Neither shape: `null`, never a guess. M06 task 1 follow-up.
import { describe, expect, test } from "vitest";
import { loadSnapshots } from "../../../src/core/recorder/load.js";
import { FakeEvidenceStore } from "../../../src/fakes/stores.js";
import type { Masked } from "../../../src/ports/masked.js";

const RUN_ID = "run_2026-09-30_load7est001";

function maskedCast<T>(v: T): Masked<T> {
  return v as Masked<T>;
}

/** One `report_outcome` proof line at turn 1, seq 6, pointing at `e1`. */
const PROOF_LINE = {
  seq: 6,
  at: "2026-09-30T10:00:00.000Z",
  run_id: RUN_ID,
  step: "t1",
  by: "llm",
  event: "llm_decision",
  data: { action: { type: "report_outcome", input: { summary: "x", proof: ["e1"] } }, valid: true, model: "x", tokens: { input: 0, output: 0 } },
};

/** Builds a run folder holding one `llm/00006_planner_request.json` file with `body`, and
 * reads back `proofElementListText` for it. */
async function textFor(body: unknown): Promise<string | null> {
  const store = new FakeEvidenceStore();
  const created = await store.createRun("keystone", RUN_ID);
  if (!created.ok) throw new Error("createRun failed in test setup");
  const folder = created.value;
  await folder.writeFile("llm/00006_planner_request.json", maskedCast(JSON.stringify(body)));
  const snapshots = await loadSnapshots(folder, [PROOF_LINE], "report_outcome");
  return snapshots.proofElementListText;
}

describe("loadSnapshots: the proof turn's element-list text, in either wire shape", () => {
  test("the real Claude adapter's shape: messages[0].content, one text block", async () => {
    const text = await textFor({
      messages: [{ role: "user", content: [{ type: "text", text: 'e1 heading "Hi"' }] }],
    });
    expect(text).toBe('e1 heading "Hi"');
  });

  test("a fake planner's flat PlannerTurn shape: a top-level message string", async () => {
    const text = await textFor({ model: "x", prompt: "x", system: "x", tools: [], message: 'e1 heading "Hi"', image: null });
    expect(text).toBe('e1 heading "Hi"');
  });

  test("neither shape: null, never a guess", async () => {
    const text = await textFor({ foo: "bar" });
    expect(text).toBeNull();
  });
});
