// Proves the table classifier (the CI fake for jev): rows answer by step, style, or input hash;
// each bucket and failure maps to the right verdict; a request is recorded before any answer; an
// unscripted call fails the test; a failed write sends nothing. Design section 5 §10.7, §10.9
// and section 9 §5.3, §5.9.
import { describe, expect, test } from "vitest";
import { reconcileVerdict, troubleVerdict } from "../../../src/core/replay/jev-verdict.js";
import { inputHash } from "../../../src/fakes/table.js";
import { TableClassifier } from "../../../src/fakes/table-classifier.js";
import type { Reply } from "../../../src/fakes/table.js";
import type { JevReconcileOutput, JevTroubleOutput } from "../../../src/ports/models.js";
import { recorder, reconcileInput, troubleInput, type Recorded } from "./table-kit.js";

const choices = { outcomes: ["x"], handlers: ["kyc_reminder"] };
const cutoffs = { handler_min: 0.8, outcome_min: 0.95, reconciliation_min: 0.9 };
const out = (o: Partial<JevTroubleOutput>): JevTroubleOutput => ({
  bucket: "needs_review",
  handler: null,
  outcome: null,
  confidence: 0.5,
  ...o,
});

/** Asks one trouble question of a one-row table and returns the verdict. */
async function verdictOf(answer: JevTroubleOutput) {
  const c = new TableClassifier({ trouble: [{ when: {}, reply: { answer } }] });
  return troubleVerdict(await c.trouble(troubleInput(), recorder([])), choices, cutoffs);
}

describe("trouble: each row through the verdict", () => {
  test("handler at 0.80 acts; at 0.79 climbs", async () => {
    const h = { bucket: "handler", handler: "kyc_reminder" } as const;
    expect((await verdictOf(out({ ...h, confidence: 0.8 }))).kind).toBe("handler");
    expect((await verdictOf(out({ ...h, confidence: 0.79 }))).kind).toBe("needs_review");
  });

  test("outcome at 0.95 decides; at 0.94 climbs", async () => {
    const o = { bucket: "outcome", outcome: "x" } as const;
    expect((await verdictOf(out({ ...o, confidence: 0.95 }))).kind).toBe("outcome");
    expect((await verdictOf(out({ ...o, confidence: 0.94 }))).kind).toBe("needs_review");
  });

  test("unsafe and needs_review rows", async () => {
    expect((await verdictOf(out({ bucket: "unsafe", confidence: 0 }))).kind).toBe("unsafe");
    expect((await verdictOf(out({ bucket: "needs_review" }))).kind).toBe("needs_review");
  });

  test("a timeout row is no answer in time", async () => {
    const c = new TableClassifier({ trouble: [{ when: {}, reply: { failure: "timeout" } }] });
    expect(troubleVerdict(await c.trouble(troubleInput(), recorder([])), choices, cutoffs)).toEqual(
      {
        kind: "needs_review",
        confidence: 0,
        warning: "classifier_unavailable",
      },
    );
  });

  test("a raw row that breaks the schema is invalid output", async () => {
    const c = new TableClassifier({
      trouble: [{ when: {}, reply: { raw: { bucket: "x" } } }],
    });
    const call = await c.trouble(troubleInput(), recorder([]));
    expect(call).toEqual({ ok: false, failure: "invalid_output" });
    expect(troubleVerdict(call, choices, cutoffs)).toEqual({
      kind: "needs_review",
      confidence: 0,
      warning: "classifier_invalid_output",
    });
  });
});

describe("call order and failures (section 9 §5.3, section 5 §10.9)", () => {
  test("a good call records the request, then the reply", async () => {
    const log: Recorded[] = [];
    const c = new TableClassifier({ trouble: [{ when: {}, reply: { answer: out({}) } }] });
    const input = troubleInput();
    await c.trouble(input, recorder(log));
    expect(log.map((l) => l.part)).toEqual(["request", "reply"]);
    expect(log[0]?.text).toBe(JSON.stringify(input));
  });

  test("an unscripted call throws, but its request was recorded first", async () => {
    const log: Recorded[] = [];
    const c = new TableClassifier({});
    await expect(c.trouble(troubleInput(), recorder(log))).rejects.toThrow(/unscripted/);
    expect(log.map((l) => l.part)).toEqual(["request"]);
  });

  test("a recorder that returns false gives write_failed and no reply is recorded", async () => {
    const log: Recorded[] = [];
    const c = new TableClassifier({ trouble: [{ when: {}, reply: { answer: out({}) } }] });
    expect(await c.trouble(troubleInput(), recorder(log, "request"))).toEqual({
      ok: false,
      failure: "write_failed",
    });
    expect(log).toEqual([]);
  });

  test("a failed reply write is write_failed too", async () => {
    const log: Recorded[] = [];
    const c = new TableClassifier({ trouble: [{ when: {}, reply: { answer: out({}) } }] });
    expect(await c.trouble(troubleInput(), recorder(log, "reply"))).toEqual({
      ok: false,
      failure: "write_failed",
    });
    expect(log.map((l) => l.part)).toEqual(["request"]);
  });
});

describe("row selection", () => {
  test("times:1 rows are consumed in order, then the next row answers", async () => {
    const c = new TableClassifier({
      trouble: [
        { when: {}, reply: { answer: out({ confidence: 0.1 }) }, times: 1 },
        { when: {}, reply: { answer: out({ confidence: 0.2 }) }, times: 1 },
        { when: {}, reply: { answer: out({ confidence: 0.3 }) } },
      ],
    });
    const conf: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await c.trouble(troubleInput(), recorder([]));
      if (r.ok) conf.push(r.value.confidence);
    }
    expect(conf).toEqual([0.1, 0.2, 0.3, 0.3]);
  });

  test("when.hash picks the row for that exact input", async () => {
    const a = troubleInput("s", "a");
    const b = troubleInput("s", "b");
    const c = new TableClassifier({
      trouble: [
        { when: { hash: inputHash(b) }, reply: { answer: out({ confidence: 0.7 }) } },
        { when: {}, reply: { answer: out({ confidence: 0.2 }) } },
      ],
    });
    const rb = await c.trouble(b, recorder([]));
    const ra = await c.trouble(a, recorder([]));
    expect(rb.ok && rb.value.confidence).toBe(0.7);
    expect(ra.ok && ra.value.confidence).toBe(0.2);
  });

  test("when.style picks by the style the test reports", async () => {
    let style: string | undefined = "slow";
    const c = new TableClassifier(
      {
        trouble: [
          { when: { style: "server_error" }, reply: { answer: out({ confidence: 0.9 }) } },
          { when: { style: "slow" }, reply: { answer: out({ confidence: 0.4 }) } },
        ],
      },
      () => style,
    );
    const slow = await c.trouble(troubleInput(), recorder([]));
    style = "server_error";
    const err = await c.trouble(troubleInput(), recorder([]));
    expect(slow.ok && slow.value.confidence).toBe(0.4);
    expect(err.ok && err.value.confidence).toBe(0.9);
    style = "other";
    await expect(c.trouble(troubleInput(), recorder([]))).rejects.toThrow(/unscripted/);
  });

  test("when.step picks by the failed step's ID", async () => {
    const c = new TableClassifier({
      trouble: [
        { when: { step: "one" }, reply: { answer: out({ confidence: 0.1 }) } },
        { when: { step: "two" }, reply: { answer: out({ confidence: 0.2 }) } },
      ],
    });
    const two = await c.trouble(troubleInput("two"), recorder([]));
    const one = await c.trouble(troubleInput("one"), recorder([]));
    expect(two.ok && two.value.confidence).toBe(0.2);
    expect(one.ok && one.value.confidence).toBe(0.1);
  });

  test("a reconcile call selects by the commit step's ID", async () => {
    const c = new TableClassifier({
      reconcile: [
        {
          when: { step: "click_confirm" },
          reply: { answer: { verdict: "found", confidence: 0.9 } },
        },
      ],
    });
    expect((await c.reconcile(reconcileInput("click_confirm"), recorder([]))).ok).toBe(true);
    await expect(c.reconcile(reconcileInput("other"), recorder([]))).rejects.toThrow(/unscripted/);
  });

  test("the fake keeps every input it was sent", async () => {
    const c = new TableClassifier({ trouble: [{ when: {}, reply: { answer: out({}) } }] });
    await c.trouble(troubleInput(), recorder([]));
    expect(c.seen.map((s) => s.kind)).toEqual(["trouble"]);
  });
});

describe("reconcile rows through the verdict", () => {
  async function verdictFor(reply: Reply<JevReconcileOutput>) {
    const c = new TableClassifier({ reconcile: [{ when: {}, reply }] });
    return reconcileVerdict(await c.reconcile(reconcileInput(), recorder([])), cutoffs);
  }

  test("found at 0.90 counts; at 0.89 is unclear", async () => {
    expect(await verdictFor({ answer: { verdict: "found", confidence: 0.9 } })).toEqual({
      verdict: "found",
      confidence: 0.9,
    });
    expect((await verdictFor({ answer: { verdict: "found", confidence: 0.89 } })).verdict).toBe(
      "unclear",
    );
  });

  test("a timeout and bad output are unclear, confidence 0", async () => {
    expect(await verdictFor({ failure: "timeout" })).toEqual({
      verdict: "unclear",
      confidence: 0,
      warning: "classifier_unavailable",
    });
    expect(await verdictFor({ raw: { verdict: "found" } })).toEqual({
      verdict: "unclear",
      confidence: 0,
      warning: "classifier_invalid_output",
    });
  });
});
