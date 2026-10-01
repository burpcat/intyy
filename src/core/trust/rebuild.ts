// The record rebuild: a pure function of a key's history lines. Same lines, same record.
// Follows design section 8 §5.2 (the record is a pure function of the logs) and §5.3.
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import { hashJson } from "../model/canonical.js";
import type { HistoryLine } from "../model/score-history.js";
import type { ScoreKey, ScoreRecord, TrustState } from "../model/score.js";
import { transition, type Move } from "./state.js";

/** Hashes from the store index, not from the logs (section 8 §5.3: `hashes`). */
export type ScoreHashes = ScoreRecord["hashes"];

/**
 * A key with no history: the synthetic draft record (section 8 §5.2: no record file means draft).
 * Its state fields are `null`, since no line set them.
 */
export function draftRecord(key: ScoreKey, hashes: ScoreHashes): ScoreRecord {
  return {
    schema: "intyy.score/1.0",
    key,
    hashes,
    state: "draft",
    state_since: null,
    state_by: null,
    state_reason: null,
    certify: null,
    regression: null,
    approval: null,
    timeouts: { approved: {}, approved_from: null, candidate: null, candidate_from: null },
    thresholds: null,
    autonomy: null,
    live: null,
    alerts: [],
  };
}

/** The move a state-changing line makes, or `null` for a line that changes no state. */
function moveOf(line: HistoryLine): Move | null {
  switch (line.event) {
    case "approved":
      return "approve";
    case "restored":
      return "restore";
    case "reinstated":
      return "reinstate";
    case "degraded":
      return "degrade";
    case "retired":
      return "retire";
    default:
      return null;
  }
}

/** Applies one line to the record. Returns the new record, or the refusal of an illegal move. */
function applyLine(
  rec: ScoreRecord,
  line: HistoryLine,
): Outcome<ScoreRecord, "illegal_move" | "needs_staff"> {
  let next: ScoreRecord = rec;
  const move = moveOf(line);
  if (move !== null) {
    const t = transition(rec.state, move, line.by);
    if (!t.ok) return t;
    const state: TrustState = t.value;
    next = {
      ...rec,
      state,
      state_since: line.at,
      state_by: line.by,
      state_reason: line.reason,
    };
  }
  switch (line.event) {
    case "batch": {
      if (line.kind === "quick") return ok(next); // Why: a quick batch is never approval-grade (section 9 §9.1).
      const summary = {
        batch: line.batch,
        at: line.at,
        gate: line.gate,
        report_hash: line.report_hash,
        under: line.under,
        scores: line.scores,
      };
      return ok(line.kind === "full" ? { ...next, certify: summary } : { ...next, regression: summary });
    }
    case "approved":
      return ok({
        ...next,
        approval: {
          batch: line.batch,
          by: line.by,
          at: line.at,
          acknowledged: line.acknowledged,
          note: line.note,
        },
      });
    case "reinstated":
      // Why: a reinstated key is a draft again. It needs a new approval (section 8 §4.2).
      return ok({ ...next, approval: null });
    case "timeouts":
      return ok({
        ...next,
        timeouts: { ...next.timeouts, approved: line.values, approved_from: line.batch },
      });
    case "thresholds":
      return ok({ ...next, thresholds: { ...line.values, batch: line.batch } });
    // Why: `excluded` and `autonomy` feed the live window and the autonomy record. M11 builds both.
    default:
      return ok(next);
  }
}

/**
 * Rebuilds the record from the history lines, in order. `bad_history` names the first line that
 * makes an illegal move, such as an approval from `retired`. Pure: no clock, no files.
 */
export function rebuild(
  key: ScoreKey,
  hashes: ScoreHashes,
  history: readonly HistoryLine[],
): Outcome<ScoreRecord, "bad_history"> {
  let rec = draftRecord(key, hashes);
  for (const [i, line] of history.entries()) {
    const next = applyLine(rec, line);
    if (!next.ok) {
      return fail("bad_history", `history line ${String(i + 1)} (${line.event}): ${next.detail ?? next.failure}`);
    }
    rec = next.value;
  }
  return ok(rec);
}

/**
 * The record hash `--expect-record` quotes (section 9 §9.4): SHA-256 of the canonical record
 * JSON, so file formatting never changes it. A synthetic draft hashes the same way.
 */
export function recordHash(record: ScoreRecord): string {
  return hashJson(record);
}
