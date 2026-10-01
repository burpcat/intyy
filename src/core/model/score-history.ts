// One line of a key's `history.jsonl`: every trust event, append only.
// Follows design section 8 §5.4 (history lines) and §4.2 (every transition is a line).
import { z } from "zod";
import { Sha256Hash } from "./canonical.js";
import { BatchScores, Timeouts, Under } from "./score.js";

/** What every history line holds: when, by whom, and why (section 8 §5.4). `by` is a staff ID, or `live_score`, `certify`, or `system`. */
const common = {
  at: z.iso.datetime(),
  by: z.string().min(1),
  reason: z.string(),
};

const Cutoffs = z
  .object({
    handler_min: z.number().min(0).max(1).optional(),
    outcome_min: z.number().min(0).max(1).optional(),
    reconciliation_min: z.number().min(0).max(1).optional(),
  })
  .strict();

/** One history line (section 8 §5.4), told apart by `event`. */
export const HistoryLine = z.discriminatedUnion("event", [
  z
    .object({
      event: z.literal("batch"),
      ...common,
      batch: z.string().min(1),
      kind: z.enum(["quick", "full", "regression"]),
      gate: z.enum(["passed", "failed"]),
      report_hash: Sha256Hash,
      under: Under,
      /** Present on a full batch once the scorer exists; `null` before. */
      scores: BatchScores.nullable(),
    })
    .strict(),
  z
    .object({
      event: z.literal("approved"),
      ...common,
      batch: z.string().min(1),
      acknowledged: z.array(z.string().min(1)),
      note: z.string().nullable(),
    })
    .strict(),
  z
    .object({ event: z.literal("rejected"), ...common, batch: z.string().min(1), note: z.string().nullable() })
    .strict(),
  z
    .object({
      event: z.literal("degraded"),
      ...common,
      rule: z.enum(["window", "streak", "certify", "human"]),
      runs: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      event: z.literal("restored"),
      ...common,
      batch: z.string().min(1).nullable(),
      exclusion: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({ event: z.literal("retired"), ...common, newer_key: z.string().min(1).nullable() })
    .strict(),
  z.object({ event: z.literal("reinstated"), ...common }).strict(),
  z.object({ event: z.literal("excluded"), ...common, runs: z.array(z.string().min(1)).min(1) }).strict(),
  z
    .object({ event: z.literal("timeouts"), ...common, batch: z.string().min(1), values: Timeouts })
    .strict(),
  z
    .object({
      event: z.literal("autonomy"),
      ...common,
      action: z.enum(["ready", "granted", "revoked"]),
      evidence: z.array(z.string().min(1)),
    })
    .strict(),
  z.object({ event: z.literal("thresholds"), ...common, batch: z.string().min(1), values: Cutoffs }).strict(),
]);

/** One history line. */
export type HistoryLine = z.infer<typeof HistoryLine>;
