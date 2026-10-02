// Proves how approval handles tuned timeouts (design section 8 §9.6 candidate, then approved;
// §5.4 history lines; section 9 §9.3 the screen's timeouts line): a `timeouts` line with values and
// a non-empty candidate sets `approved`, `approved_from`, `candidate`, and `candidate_from` to the
// batch; an empty candidate clears the candidate; an absent one leaves it; and the review screen
// reads `installs <values or defaults>; candidates <step value s, ...>`, or says there are no
// candidates, and why when the batch ran with shortened delays. No files, no clock. M10 task 11.
import { describe, expect, test } from "vitest";
import { BatchReport } from "../../../src/core/model/batch-report.js";
import { hashJson } from "../../../src/core/model/canonical.js";
import type { HistoryLine } from "../../../src/core/model/score-history.js";
import { buildReview, type ReviewFacts } from "../../../src/core/trust/approval.js";
import { rebuild } from "../../../src/core/trust/rebuild.js";
import { approved, batch, h, HASHES, KEY, SCORES } from "./kit.js";

const timeoutsLine = (minute: number, batchId: string, values: Record<string, number>, candidate?: Record<string, number>): HistoryLine => ({
  event: "timeouts",
  at: `2026-01-15T09:${String(minute).padStart(2, "0")}:00.000Z`,
  by: "op_022",
  reason: "Installed.",
  batch: batchId,
  values,
  ...(candidate === undefined ? {} : { candidate }),
});

function recordOf(lines: HistoryLine[]) {
  const r = rebuild(KEY, HASHES, lines);
  if (!r.ok) throw new Error(`test setup: rebuild failed: ${r.detail ?? r.failure}`);
  return r.value.timeouts;
}

describe("rebuild of a timeouts line", () => {
  const base = [batch(1, "batch_a"), approved(2, "op_022", "batch_a")];

  test("a timeouts line sets approved and candidate values, clears or keeps the candidate", () => {
    // values and a non-empty candidate set approved and candidate, both from the batch
    {
      const t = recordOf([...base, timeoutsLine(3, "batch_a", { click_search: 9000 }, { click_search: 10000 })]);
      expect(t).toEqual({ approved: { click_search: 9000 }, approved_from: "batch_a", candidate: { click_search: 10000 }, candidate_from: "batch_a" });
    }
    // an empty candidate clears the candidate
    {
      const t = recordOf([...base, timeoutsLine(3, "batch_a", {}, { click_search: 10000 }), timeoutsLine(4, "batch_b", { click_search: 10000 }, {})]);
      expect(t).toEqual({ approved: { click_search: 10000 }, approved_from: "batch_b", candidate: null, candidate_from: null });
    }
    // an absent candidate leaves the candidate as it was
    {
      const t = recordOf([...base, timeoutsLine(3, "batch_a", {}, { click_search: 10000 }), timeoutsLine(4, "batch_b", { click_search: 7000 })]);
      expect(t).toEqual({ approved: { click_search: 7000 }, approved_from: "batch_b", candidate: { click_search: 10000 }, candidate_from: "batch_a" });
    }
  });
});

/** Review facts for a full batch whose report holds `timeouts` (`undefined`: the field is absent). */
function factsWith(timeouts: unknown): ReviewFacts {
  const report = BatchReport.parse({
    schema: "intyy.batch_report/1.0",
    batch_id: "batch_a",
    tenant: "keystone",
    app: "kvfcu",
    capability: "kvfcu/open_share_subaccount@1",
    ended_at: "2026-01-15T09:00:00.000Z",
    kind: "full",
    cases: [{ case_id: "baseline_1", run_id: "run_1", class: "valid", result: { status: "success", detail: null }, truth: {}, verdict: "pass" }],
    gate: { passed: true, rules: { complete: true, no_wrong: true, baseline: true, matrix: true, extra: true, no_void: true } },
    ...(timeouts === undefined ? {} : { timeouts }),
  });
  const rec = rebuild(KEY, HASHES, [batch(1, "batch_a", { report_hash: hashJson(report), scores: SCORES })]);
  if (!rec.ok) throw new Error("test setup: rebuild failed");
  return {
    key: KEY,
    record: rec.value,
    batchId: "batch_a",
    report,
    now: { engine: "0.4.0", handlerSet: h("handlers") },
    artifactSealed: true,
    links: [],
    sealer: "op_017",
    who: { staff: "op_022", roles: ["approver"] },
    decisions: [],
    prior: [],
  };
}

const t = (over: Record<string, unknown>) => ({ ran_with: {}, ran_with_from: null, proposed: {}, not_proposed: {}, ...over });
const screen = (timeouts: unknown): string => buildReview(factsWith(timeouts)).timeouts;

describe("the review screen's timeouts line", () => {
  test("the review screen timeouts line reads each kind of batch", () => {
    // a batch with proposals reads installs defaults; candidates
    expect(screen(t({ proposed: { click_search: 10000, click_submit: 15000 } }))).toBe("installs defaults; candidates click_search 10 s, click_submit 15 s");
    // a batch that ran with tuned values says what approval installs
    expect(screen(t({ ran_with: { click_search: 12500 }, proposed: { click_search: 12500 } }))).toBe("installs click_search 12.5 s; candidates click_search 12.5 s");
    // a batch with no proposals says no candidates
    expect(screen(t({ not_proposed: { click_search: "3 samples" } }))).toBe("installs defaults; no candidates");
    // a scaled batch says why there are no candidates
    expect(screen(t({ scaled: true }))).toBe("installs defaults; no candidates, the batch ran with shortened delays");
    // a report with no timeouts field says installs defaults; no candidates
    expect(screen(undefined)).toBe("installs defaults; no candidates");
  });
});
