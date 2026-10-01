// Shared builders for the trust tests: a fixed score key, hashes, and history lines.
// Not a test file. Design section 8 §5.1, §5.3, §5.4. M10 task 1.
import { hashJson } from "../../../src/core/model/canonical.js";
import type { HistoryLine } from "../../../src/core/model/score-history.js";
import type { BatchScores, ScoreKey, ScoreRecord } from "../../../src/core/model/score.js";
import { draftRecord } from "../../../src/core/trust/rebuild.js";

/** A made-up key with no patch. */
export const KEY: ScoreKey = {
  capability: "kvfcu/open_share_subaccount@1.0.0",
  tenant: "keystone",
  app_version: "9.2",
  patch_revision: null,
};

/** A `sha256:` value made from a tag, so each tag gives its own hash. */
export const h = (tag: string): string => hashJson({ tag });

/** The store index hashes of the key. */
export const HASHES: ScoreRecord["hashes"] = { artifact: h("artifact"), patch: null };

/** A fresh synthetic draft record for `KEY`. */
export const DRAFT: ScoreRecord = draftRecord(KEY, HASHES);

const T = (minute: number): string => `2026-01-15T09:${String(minute).padStart(2, "0")}:00.000Z`;

/** The scores a full batch carries. */
export const SCORES: BatchScores = {
  outcome_score: 0.97,
  verdicts: { pass: 10, explained: 2, assisted: 1, unexplained: 0, wrong: 0, void: 0 },
  margin: { lowest: 0.24, step: "open_member" },
  fragile: ["open_member"],
};

const UNDER = {
  engine: "0.4.0",
  handler_set: h("handlers"),
  jev: null,
  session: null,
  check: null,
};

/** A `batch` line. `kind` defaults to `full`; `scores` is `SCORES` for a full batch. */
export function batch(
  minute: number,
  id: string,
  over: Partial<Extract<HistoryLine, { event: "batch" }>> = {},
): HistoryLine {
  const kind = over.kind ?? "full";
  return {
    event: "batch",
    at: T(minute),
    by: "certify",
    reason: `${kind} batch`,
    batch: id,
    kind,
    gate: "passed",
    report_hash: h(`report-${id}`),
    under: UNDER,
    scores: kind === "full" ? SCORES : null,
    ...over,
  };
}

/** An `approved` line. */
export const approved = (minute: number, by = "op_022", id = "batch_a"): HistoryLine => ({
  event: "approved",
  at: T(minute),
  by,
  reason: "Batch passed.",
  batch: id,
  acknowledged: ["open_member"],
  note: null,
});

/** A `degraded` line. */
export const degraded = (minute: number, by = "live_score"): HistoryLine => ({
  event: "degraded",
  at: T(minute),
  by,
  reason: "Window rule.",
  rule: "window",
  runs: ["run_a"],
});

/** A `restored` line. */
export const restored = (minute: number, by = "op_022"): HistoryLine => ({
  event: "restored",
  at: T(minute),
  by,
  reason: "Fixed.",
  batch: "batch_b",
  exclusion: null,
});

/** A `retired` line. */
export const retired = (minute: number, by = "op_017"): HistoryLine => ({
  event: "retired",
  at: T(minute),
  by,
  reason: "Not needed.",
  newer_key: null,
});

/** A `reinstated` line. */
export const reinstated = (minute: number, by = "op_022"): HistoryLine => ({
  event: "reinstated",
  at: T(minute),
  by,
  reason: "Needed again.",
});
