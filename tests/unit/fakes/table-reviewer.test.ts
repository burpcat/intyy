// Proves the table reviewer (the CI fake for the rung-3 reviewer): one action or a give-up from
// a row, bad output as invalid_output, an unscripted call fails the test, the second opinion
// works like jev's reconciliation, and the request is recorded before the reply.
// Design section 5 §10.9, §11.2 and section 9 §5.3, §5.9.
import { describe, expect, test } from "vitest";
import { reconcileVerdict } from "../../../src/core/replay/jev-verdict.js";
import { TableReviewer } from "../../../src/fakes/table-reviewer.js";
import { recorder, reconcileInput, reviewerInput, type Recorded } from "./table-kit.js";

const click = {
  action: { type: "click", element: "e1" },
  reason: "A notice covers the page.",
  expected: "The form shows.",
} as const;

describe("fixStep", () => {
  test("the table reviewer fixStep answers each row kind and records before replying", async () => {
    // an action row answers with one action
    {
      const r = new TableReviewer({ fixStep: [{ when: {}, reply: { answer: click } }] });
      expect(await r.fixStep(reviewerInput(), recorder([]))).toEqual({ ok: true, value: click });
    }
    // a give_up row answers with a refusal
    {
      const giveUp = { give_up: true, reason: "I cannot approve this." } as const;
      const r = new TableReviewer({ fixStep: [{ when: {}, reply: { answer: giveUp } }] });
      expect(await r.fixStep(reviewerInput(), recorder([]))).toEqual({ ok: true, value: giveUp });
    }
    // a raw row with a bad action is invalid_output
    {
      const r = new TableReviewer({
        fixStep: [
          { when: {}, reply: { raw: { action: { type: "teleport" }, reason: "r", expected: "e" } } },
        ],
      });
      expect(await r.fixStep(reviewerInput(), recorder([]))).toEqual({
        ok: false,
        failure: "invalid_output",
      });
    }
    // an unscripted call throws, after its request is recorded
    {
      const log: Recorded[] = [];
      const r = new TableReviewer({});
      await expect(r.fixStep(reviewerInput(), recorder(log))).rejects.toThrow(/unscripted/);
      expect(log.map((l) => l.part)).toEqual(["request"]);
    }
    // the request is recorded before the reply, and equals the input
    {
      const log: Recorded[] = [];
      const input = reviewerInput();
      const r = new TableReviewer({ fixStep: [{ when: {}, reply: { answer: click } }] });
      await r.fixStep(input, recorder(log));
      expect(log.map((l) => l.part)).toEqual(["request", "reply"]);
      expect(log[0]?.text).toBe(JSON.stringify(input));
    }
    // a failed request write sends nothing
    {
      const log: Recorded[] = [];
      const r = new TableReviewer({ fixStep: [{ when: {}, reply: { answer: click } }] });
      expect(await r.fixStep(reviewerInput(), recorder(log, "request"))).toEqual({
        ok: false,
        failure: "write_failed",
      });
      expect(log).toEqual([]);
    }
    // when.step picks the row
    {
      const r = new TableReviewer({
        fixStep: [
          { when: { step: "other" }, reply: { failure: "timeout" } },
          { when: { step: "open_form" }, reply: { answer: click } },
        ],
      });
      expect((await r.fixStep(reviewerInput("open_form"), recorder([]))).ok).toBe(true);
      expect(await r.fixStep(reviewerInput("other"), recorder([]))).toEqual({
        ok: false,
        failure: "timeout",
      });
    }
  });
});

describe("secondOpinion", () => {
  const cutoffs = { reconciliation_min: 0.9 };

  test("the table reviewer secondOpinion answers by confidence and throws when unscripted", async () => {
    // found at 0.90 counts, 0.89 is unclear
    {
      const mk = (confidence: number) =>
        new TableReviewer({
          secondOpinion: [{ when: {}, reply: { answer: { verdict: "found", confidence } } }],
        });
      expect(
        reconcileVerdict(await mk(0.9).secondOpinion(reconcileInput(), recorder([])), cutoffs)
          .verdict,
      ).toBe("found");
      expect(
        reconcileVerdict(await mk(0.89).secondOpinion(reconcileInput(), recorder([])), cutoffs)
          .verdict,
      ).toBe("unclear");
    }
    // a timeout and bad output are unclear, confidence 0
    {
      const timeout = new TableReviewer({
        secondOpinion: [{ when: {}, reply: { failure: "timeout" } }],
      });
      expect(
        reconcileVerdict(await timeout.secondOpinion(reconcileInput(), recorder([])), cutoffs),
      ).toEqual({
        verdict: "unclear",
        confidence: 0,
        warning: "classifier_unavailable",
      });
      const bad = new TableReviewer({ secondOpinion: [{ when: {}, reply: { raw: 5 } }] });
      expect(
        reconcileVerdict(await bad.secondOpinion(reconcileInput(), recorder([])), cutoffs).warning,
      ).toBe("classifier_invalid_output");
    }
    // an unscripted second opinion throws
    {
      const r = new TableReviewer({});
      await expect(r.secondOpinion(reconcileInput(), recorder([]))).rejects.toThrow(/unscripted/);
    }
  });
});
