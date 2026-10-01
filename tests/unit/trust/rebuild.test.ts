// Proves the score record rebuild is a pure function of the history lines (design section 8
// §5.2 "same logs, same bytes", §5.3 record fields, §5.4 history lines): a golden record from
// fixed lines, equal canonical JSON and record hash on two runs, no lines gives the synthetic
// draft, a quick batch changes nothing, a full batch fills `certify`, a regression batch fills
// `regression`, and an illegal line fails with `bad_history` and its line number. M10 task 1.
import { describe, expect, test } from "vitest";
import { canonicalJson, hashJson } from "../../../src/core/model/canonical.js";
import type { HistoryLine } from "../../../src/core/model/score-history.js";
import { draftRecord, rebuild, recordHash } from "../../../src/core/trust/rebuild.js";
import { ScoreRecord } from "../../../src/core/model/score.js";
import { approved, batch, degraded, DRAFT, h, HASHES, KEY, reinstated, restored, retired, SCORES } from "./kit.js";

/** The lines of the golden case: every kind the rebuild reads, and three it ignores. */
const LINES: HistoryLine[] = [
  batch(1, "batch_a"),
  batch(2, "batch_q", { kind: "quick" }),
  approved(3),
  { event: "timeouts", at: "2026-01-15T09:04:00.000Z", by: "op_022", reason: "Tuned.", batch: "batch_a", values: { click_search: 10000 } },
  { event: "thresholds", at: "2026-01-15T09:05:00.000Z", by: "certify", reason: "Tighter.", batch: "batch_a", values: { handler_min: 0.9 } },
  batch(6, "batch_r", { kind: "regression" }),
  { event: "excluded", at: "2026-01-15T09:07:00.000Z", by: "op_022", reason: "Bad run.", runs: ["run_a"] },
  { event: "autonomy", at: "2026-01-15T09:08:00.000Z", by: "op_022", reason: "Ready.", action: "ready", evidence: ["run_a"] },
  { event: "rejected", at: "2026-01-15T09:09:00.000Z", by: "op_022", reason: "No.", batch: "batch_q", note: null },
];

/** What the golden lines must give. Written out by hand from section 8 §5.3. */
const GOLDEN: ScoreRecord = {
  schema: "intyy.score/1.0",
  key: KEY,
  hashes: HASHES,
  state: "approved",
  state_since: "2026-01-15T09:03:00.000Z",
  state_by: "op_022",
  state_reason: "Batch passed.",
  certify: {
    batch: "batch_a",
    at: "2026-01-15T09:01:00.000Z",
    gate: "passed",
    report_hash: h("report-batch_a"),
    under: { engine: "0.4.0", handler_set: h("handlers"), jev: null, session: null, check: null },
    scores: SCORES,
  },
  regression: {
    batch: "batch_r",
    at: "2026-01-15T09:06:00.000Z",
    gate: "passed",
    report_hash: h("report-batch_r"),
    under: { engine: "0.4.0", handler_set: h("handlers"), jev: null, session: null, check: null },
    scores: null,
  },
  approval: {
    batch: "batch_a",
    by: "op_022",
    at: "2026-01-15T09:03:00.000Z",
    acknowledged: ["open_member"],
    note: null,
  },
  timeouts: { approved: { click_search: 10000 }, approved_from: "batch_a", candidate: null, candidate_from: null },
  thresholds: { handler_min: 0.9, batch: "batch_a" },
  autonomy: null,
  live: null,
  alerts: [],
};

/** The record of lines that must succeed. */
function built(lines: HistoryLine[]): ScoreRecord {
  const r = rebuild(KEY, HASHES, lines);
  if (!r.ok) throw new Error(`rebuild failed: ${r.detail ?? r.failure}`);
  return r.value;
}

describe("record rebuild: golden", () => {
  test("fixed lines give the exact record", () => {
    expect(built(LINES)).toEqual(GOLDEN);
    expect(ScoreRecord.safeParse(built(LINES)).success).toBe(true);
  });

  test("two runs give equal canonical JSON and equal record hashes", () => {
    const a = built(LINES);
    const b = built(structuredClone(LINES));
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe(canonicalJson(GOLDEN));
    expect(recordHash(a)).toBe(recordHash(b));
    expect(recordHash(a)).toBe(hashJson(GOLDEN));
    expect(recordHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("the record hash changes when any field changes", () => {
    const other = built([...LINES, degraded(10)]);
    expect(recordHash(other)).not.toBe(recordHash(built(LINES)));
  });

  test("rebuild does not change its input lines", () => {
    const copy = structuredClone(LINES);
    built(LINES);
    expect(LINES).toEqual(copy);
  });
});

describe("record rebuild: what each line does", () => {
  test("no lines give the synthetic draft, with null state fields", () => {
    expect(built([])).toEqual(draftRecord(KEY, HASHES));
    expect(DRAFT).toMatchObject({
      state: "draft",
      state_since: null,
      state_by: null,
      state_reason: null,
      certify: null,
      regression: null,
      approval: null,
    });
  });

  test("a quick batch changes no record field", () => {
    expect(built([batch(1, "batch_q", { kind: "quick" })])).toEqual(DRAFT);
    expect(built([batch(1, "batch_q", { kind: "quick", gate: "failed" })])).toEqual(DRAFT);
    expect(built([batch(1, "batch_a"), batch(2, "batch_q", { kind: "quick" })])).toEqual(
      built([batch(1, "batch_a")]),
    );
  });

  test("a full batch fills certify only; a later full batch replaces it", () => {
    const one = built([batch(1, "batch_a")]);
    expect(one.certify?.batch).toBe("batch_a");
    expect(one.regression).toBeNull();
    expect(one.state).toBe("draft");
    const two = built([batch(1, "batch_a"), batch(2, "batch_b", { gate: "failed" })]);
    expect(two.certify).toMatchObject({ batch: "batch_b", gate: "failed" });
  });

  test("a drill batch line leaves the record as it was, whatever its kind", () => {
    const before = built([batch(1, "batch_a"), approved(2)]);
    for (const kind of ["full", "regression"] as const) {
      const drill = batch(3, "batch_d", { kind, drill: true, gate: "failed" });
      expect(built([batch(1, "batch_a"), approved(2), drill])).toEqual(before);
    }
    expect(built([batch(1, "batch_d", { drill: true })])).toEqual(DRAFT);
  });

  test("a regression batch fills regression only", () => {
    const r = built([batch(1, "batch_r", { kind: "regression" })]);
    expect(r.regression).toMatchObject({ batch: "batch_r", scores: null });
    expect(r.certify).toBeNull();
  });

  test("excluded, autonomy, and rejected lines leave the record as it was", () => {
    const before = built([batch(1, "batch_a"), approved(2)]);
    expect(built([batch(1, "batch_a"), approved(2), ...LINES.slice(6)])).toEqual(before);
  });

  test("state lines set state, who, why, and when", () => {
    const r = built([approved(1), degraded(2), restored(3, "op_031"), retired(4, "system")]);
    expect(r).toMatchObject({
      state: "retired",
      state_by: "system",
      state_reason: "Not needed.",
      state_since: "2026-01-15T09:04:00.000Z",
    });
  });

  test("reinstated makes a draft again and clears the approval", () => {
    const r = built([approved(1), retired(2), reinstated(3)]);
    expect(r.state).toBe("draft");
    expect(r.approval).toBeNull();
    expect(r.state_by).toBe("op_022");
  });

  test("a degraded key keeps its approval record until a new line replaces it", () => {
    const r = built([approved(1), degraded(2)]);
    expect(r.state).toBe("degraded");
    expect(r.approval?.by).toBe("op_022");
  });
});

describe("record rebuild: an illegal line", () => {
  test.each([
    ["degrade from draft", [batch(1, "batch_a"), degraded(2)], 2],
    ["approve from retired", [approved(1), retired(2), approved(3)], 3],
    ["restore from approved", [approved(1), restored(2)], 2],
    ["reinstate from draft", [reinstated(1)], 1],
    ["retire twice", [approved(1), retired(2), retired(3)], 3],
    ["an approval by certify", [approved(1, "certify")], 1],
    ["an approval by an empty actor", [batch(1, "batch_a"), batch(2, "batch_b"), approved(3, "")], 3],
    ["a retire by live_score", [approved(1), retired(2, "live_score")], 2],
  ] as const)("%s fails with bad_history at line %i", (_name, lines, n) => {
    const r = rebuild(KEY, HASHES, [...lines]);
    expect(r).toMatchObject({ ok: false, failure: "bad_history" });
    expect(r.ok ? "" : r.detail).toContain(`line ${String(n)}`);
  });
});
