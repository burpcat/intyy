// Proves the tag agreement table (design section 8 §14.3 LLM tag agreement, section 2 §17.2 and
// §17.3 provenance runs and actions): `tagTable` skips unreviewed actions, counts reviewed and
// agreed, splits groups by model, prompt, and tag type, sorts rows by model, prompt, tag type, and
// marks a row `ready` only with 50 or more reviewed, agreement 0.98 or more, and no human change
// among the newest 20; `actionsOf` takes each action's model from its source run (`unknown` when
// the run is not listed) and has no prompt. Pure; no files. M10.
import { describe, expect, test } from "vitest";
import { Artifact as ArtifactSchema, type Artifact } from "../../../src/core/model/artifact.js";
import { actionsOf, tagTable, type TaggedAction } from "../../../src/core/certify/tag-agreement.js";
import { artifactExample } from "../../fixtures/design-examples.js";

/** `n` actions of one group, oldest first. `changedAt` lists the 1-based positions a human changed. */
function run(n: number, changedAt: number[] = [], over: Partial<TaggedAction> = {}): TaggedAction[] {
  return Array.from({ length: n }, (_, i) => ({
    model: "model-a",
    prompt: "p1",
    llm_tag: "flow_step",
    human_tag: changedAt.includes(i + 1) ? "incidental" : "flow_step",
    ...over,
  }));
}

describe("tagTable", () => {
  test("tagTable counts reviewed and agreed actions per model, prompt, and tag, sorted", () => {
    // no actions give no rows
    {
      expect(tagTable([])).toEqual([]);
    }
    // an action no human has decided is skipped
    {
      expect(tagTable([{ model: "m", prompt: null, llm_tag: "flow_step", human_tag: null }])).toEqual([]);
    }
    // three actions, two kept and one changed: reviewed 3, agreed 2, agreement 2/3
    {
      const [row] = tagTable(run(3, [2]));
      expect(row).toMatchObject({ reviewed: 3, agreed: 2, recent_changes: 1, ready: false });
      expect(row?.agreement).toBeCloseTo(2 / 3, 10);
    }
    // an unreviewed action does not count among the reviewed
    {
      const rows = tagTable([...run(2), { model: "model-a", prompt: "p1", llm_tag: "flow_step", human_tag: null }]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ reviewed: 2, agreed: 2, agreement: 1 });
    }
    // groups split by model, by prompt version, and by the LLM's tag
    {
      const rows = tagTable([
        ...run(1),
        ...run(1, [], { model: "model-b" }),
        ...run(1, [], { prompt: "p2" }),
        ...run(1, [], { llm_tag: "exploration", human_tag: "exploration" }),
      ]);
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.reviewed === 1)).toBe(true);
    }
    // the tag type is the LLM's tag, so a changed action counts against the type the LLM chose
    {
      const rows = tagTable([{ model: "m", prompt: null, llm_tag: "exploration", human_tag: "flow_step" }]);
      expect(rows).toEqual([expect.objectContaining({ tag_type: "exploration", reviewed: 1, agreed: 0, agreement: 0 })]);
    }
    // rows sort by model, then prompt, then tag type, whatever the input order
    {
      const a = (model: string, prompt: string | null, llm_tag: string): TaggedAction => ({ model, prompt, llm_tag, human_tag: llm_tag });
      const rows = tagTable([
        a("model-b", "p1", "flow_step"),
        a("model-a", "p2", "flow_step"),
        a("model-a", "p1", "incidental"),
        a("model-a", "p1", "correction"),
        a("model-a", null, "flow_step"),
      ]);
      expect(rows.map((r) => [r.model, r.prompt, r.tag_type])).toEqual([
        ["model-a", null, "flow_step"],
        ["model-a", "p1", "correction"],
        ["model-a", "p1", "incidental"],
        ["model-a", "p2", "flow_step"],
        ["model-b", "p1", "flow_step"],
      ]);
    }
  });
});

describe("ready", () => {
  test("ready needs 50 reviewed, 0.98 agreement, and no change in the newest 20", () => {
    // 50 reviewed, 49 agreed (0.98), the one change not among the newest 20: ready
    {
      const [row] = tagTable(run(50, [1]));
      expect(row).toMatchObject({ reviewed: 50, agreed: 49, recent_changes: 0, ready: true });
      expect(row?.agreement).toBeCloseTo(0.98, 10);
    }
    // the same counts with the change among the newest 20: not ready
    {
      expect(tagTable(run(50, [31]))[0]).toMatchObject({ recent_changes: 1, ready: false });
      expect(tagTable(run(50, [50]))[0]).toMatchObject({ recent_changes: 1, ready: false });
    }
    // the window is the newest 20: position 30 is outside, 31 is inside
    {
      expect(tagTable(run(50, [30]))[0]).toMatchObject({ recent_changes: 0, ready: true });
      expect(tagTable(run(50, [31]))[0]).toMatchObject({ recent_changes: 1, ready: false });
    }
    // 49 reviewed at 100%: not ready (too few)
    {
      expect(tagTable(run(49))[0]).toMatchObject({ reviewed: 49, agreement: 1, ready: false });
    }
    // 50 reviewed, 48 agreed (0.96): not ready (too low)
    {
      expect(tagTable(run(50, [1, 2]))[0]).toMatchObject({ agreed: 48, recent_changes: 0, ready: false });
    }
    // 50 reviewed at 100%: ready
    {
      expect(tagTable(run(50))[0]).toMatchObject({ agreement: 1, ready: true });
    }
  });
});

describe("actionsOf", () => {
  const RUN_A = "run_2026-01-15_aaaaaaaaaa";
  const RUN_B = "run_2026-01-15_bbbbbbbbbb";
  const RUN_X = "run_2026-01-15_cccccccccc";

  function artifact(): Artifact {
    const doc = JSON.parse(JSON.stringify(artifactExample())) as { provenance: Record<string, unknown> };
    const run = (id: string, model: string) => ({ run_id: id, kind: "discovery", goal: "Open it.", model, recorder_version: "0.1.0" });
    const action = (id: string, seq: number, llm: string, human: string | null) => ({
      run_id: id,
      seq,
      llm_tag: llm,
      human_tag: human,
      decided_by: human === null ? null : "op_017",
      became: "dropped",
    });
    doc.provenance.runs = [run(RUN_A, "model-a"), run(RUN_B, "model-b")];
    doc.provenance.actions = [
      action(RUN_A, 0, "flow_step", "flow_step"),
      action(RUN_B, 0, "incidental", "flow_step"),
      action(RUN_X, 0, "exploration", null),
    ];
    return ArtifactSchema.parse(doc);
  }

  test("actionsOf gives each action its run model", () => {
    // each action gets its run's model; a run that is not listed is unknown; the prompt is not recorded
    {
      expect(actionsOf(artifact())).toEqual([
        { model: "model-a", prompt: null, llm_tag: "flow_step", human_tag: "flow_step" },
        { model: "model-b", prompt: null, llm_tag: "incidental", human_tag: "flow_step" },
        { model: "unknown", prompt: null, llm_tag: "exploration", human_tag: null },
      ]);
    }
    // two runs on different models give two rows
    {
      const rows = tagTable(actionsOf(artifact()));
      expect(rows.map((r) => [r.model, r.tag_type, r.agreed, r.reviewed])).toEqual([
        ["model-a", "flow_step", 1, 1],
        ["model-b", "incidental", 0, 1],
      ]);
    }
  });
});
