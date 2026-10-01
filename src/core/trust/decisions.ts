// The staff decisions on a key: approve, reject, restore, reinstate, demote, retire. Each checks
// the state machine (`decide`), then appends history lines under the score lock.
// Follows design section 8 §4.2 (transitions), §10.5 (what approval does), §10.6 to §10.9, and
// section 9 §9.4 (the approval family). The rules that block an approval live in approval.ts.
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { HistoryLine } from "../model/score-history.js";
import type { ScoreKey, ScoreRecord } from "../model/score.js";
import type { Role } from "../model/staff.js";
import { keyPath, keyText } from "./keys.js";
import { evaluateRules } from "./live-rules.js";
import { appendHistory, type ScoreDeps, type ScoreFailure, type ScoreWriter } from "./scores.js";
import { decide, type Move } from "./state.js";

/** Why a decision did not happen: a score write failure, or the state machine's refusal. */
export type DecisionFailure =
  | ScoreFailure
  | "illegal_move"
  | "needs_staff"
  | "role"
  /** `exclude` named a run that is not in the key's live lines. */
  | "unknown_run"
  /** `restore --after-exclusion`: no live rule degraded the key, or none of its runs was excluded. */
  | "no_exclusion"
  /** `restore --after-exclusion`: a rule still fires with the exclusions applied. */
  | "rule_still_fires";

/** Who decides, when, and under which lock identity. */
export type Decider = { at: Date; staff: string; roles: readonly Role[]; who: ScoreWriter };

/** Checks the move with the state machine, then appends the line (section 8 §4.2). */
async function staffMove(
  deps: ScoreDeps,
  record: ScoreRecord,
  move: Move,
  d: Decider,
  line: HistoryLine,
): Promise<Outcome<ScoreRecord, DecisionFailure>> {
  const allowed = decide(record.state, move, d.staff, d.roles);
  if (!allowed.ok) return fail(allowed.failure, allowed.detail);
  return appendHistory(deps, record.key, line, d.who);
}

/**
 * Approves a key (section 8 §10.5): an `approved` line, a `timeouts` line that installs the values
 * the batch ran with, and a `retired` line, by `system`, for each prior approved key of the context.
 * The approved line goes first: if a later write fails, the key is approved and a person can retire
 * the old one, which is safer than retiring first and leaving no approved key.
 */
export async function approveKey(
  deps: ScoreDeps,
  record: ScoreRecord,
  d: Decider,
  o: {
    batch: string;
    acknowledged: readonly string[];
    note: string | null;
    /** The values the batch ran with. Empty means the defaults (section 8 §9.6). */
    timeouts?: Record<string, number>;
    /** The batch's own proposals, which become the key's candidates (section 8 §9.6). Empty: none. */
    candidate?: Record<string, number>;
    /** The context's other approved keys for this capability and major. */
    prior: readonly ScoreKey[];
  },
): Promise<Outcome<{ record: ScoreRecord; retired: string[] }, DecisionFailure>> {
  const at = d.at.toISOString();
  const approved = await staffMove(deps, record, "approve", d, {
    event: "approved",
    at,
    by: d.staff,
    reason: `Approved on batch ${o.batch}.`,
    batch: o.batch,
    acknowledged: [...o.acknowledged],
    note: o.note,
  });
  if (!approved.ok) return approved;
  const timeouts = await appendHistory(
    deps,
    record.key,
    {
      event: "timeouts",
      at,
      by: d.staff,
      reason: `Installed with the approval of batch ${o.batch}.`,
      batch: o.batch,
      values: o.timeouts ?? {},
      candidate: o.candidate ?? {},
    },
    d.who,
  );
  if (!timeouts.ok) return timeouts;
  const retired: string[] = [];
  for (const old of o.prior) {
    const done = await appendHistory(
      deps,
      old,
      {
        event: "retired",
        at,
        by: "system",
        reason: `Retired: ${keyText(record.key)} was approved for the same context and major.`,
        newer_key: keyText(record.key),
      },
      d.who,
    );
    if (!done.ok) return fail(done.failure, `${keyText(old)} was not retired: ${done.detail ?? done.failure}`);
    retired.push(keyText(old));
  }
  return ok({ record: timeouts.value, retired });
}

/** Records a rejection (section 8 §10.6). The key stays as it was; only an approver may reject. */
export async function rejectKey(
  deps: ScoreDeps,
  record: ScoreRecord,
  d: Decider,
  o: { batch: string; note: string | null },
): Promise<Outcome<ScoreRecord, DecisionFailure>> {
  if (!d.roles.includes("approver")) return fail("role", `${d.staff} needs the approver role to reject`);
  return appendHistory(
    deps,
    record.key,
    {
      event: "rejected",
      at: d.at.toISOString(),
      by: d.staff,
      reason: `Rejected batch ${o.batch}.`,
      batch: o.batch,
      note: o.note,
    },
    d.who,
  );
}

/** Restores a degraded key on a new full batch (section 8 §10.8). Exclusions arrive in M11. */
export function restoreKey(
  deps: ScoreDeps,
  record: ScoreRecord,
  d: Decider,
  o: { batch: string; note: string | null },
): Promise<Outcome<ScoreRecord, DecisionFailure>> {
  return staffMove(deps, record, "restore", d, {
    event: "restored",
    at: d.at.toISOString(),
    by: d.staff,
    reason: o.note ?? `Restored on batch ${o.batch}.`,
    batch: o.batch,
    exclusion: null,
  });
}

/**
 * Excludes live runs from the key's window (section 8 §12.5). Only an approver may: it can give trust
 * back. Every run must be one of the key's live lines. The runs stay in `live.jsonl`; the `excluded`
 * line marks them, and a rebuild leaves them out of the score.
 */
export async function excludeRuns(
  deps: ScoreDeps,
  record: ScoreRecord,
  d: Decider,
  o: { runs: readonly string[]; reason: string },
): Promise<Outcome<ScoreRecord, DecisionFailure>> {
  if (!d.roles.includes("approver")) return fail("role", `${d.staff} needs the approver role to exclude runs`);
  const live = await deps.scores.liveLines(keyPath(record.key));
  if (!live.ok) return fail("invalid", live.detail);
  const known = new Set(live.value.map((l) => l.run_id));
  const missing = o.runs.filter((r) => !known.has(r));
  if (missing.length > 0) return fail("unknown_run", `no live line for ${missing.join(", ")} in ${keyText(record.key)}`);
  return appendHistory(
    deps,
    record.key,
    { event: "excluded", at: d.at.toISOString(), by: d.staff, reason: o.reason, runs: [...new Set(o.runs)] },
    d.who,
  );
}

/**
 * Restores a degraded key without a new batch (section 8 §10.8, "excluded runs"). The key must have been
 * degraded by a live rule, and a human must have excluded at least one of the runs that degraded it. With
 * the exclusions applied, no rule may still fire (the rules read lines since the last approval or restore).
 * The `restored` line carries the exclusion's ID, the `at` of the latest `excluded` line that took one of those runs.
 */
export async function restoreAfterExclusion(
  deps: ScoreDeps,
  record: ScoreRecord,
  d: Decider,
  o: { note: string | null },
): Promise<Outcome<ScoreRecord, DecisionFailure>> {
  const allowed = decide(record.state, "restore", d.staff, d.roles);
  if (!allowed.ok) return fail(allowed.failure, allowed.detail);
  const path = keyPath(record.key);
  const history = await deps.scores.history(path);
  if (!history.ok) return fail("invalid", history.detail);
  const live = await deps.scores.liveLines(path);
  if (!live.ok) return fail("invalid", live.detail);
  const degraded = history.value.findLast((l) => l.event === "degraded");
  if (degraded?.event !== "degraded" || degraded.by !== "live_score") {
    return fail("no_exclusion", "the key was not degraded by a live rule, so excluded runs cannot restore it");
  }
  const took = new Set(degraded.runs);
  const exclusion = history.value.findLast((l) => l.event === "excluded" && l.runs.some((r) => took.has(r)));
  if (exclusion === undefined) {
    return fail("no_exclusion", "no run that degraded the key is excluded; run intyy trust exclude first");
  }
  // Why "approved": the key is degraded now, but the rules ask whether it would stand if it were approved again.
  const hit = evaluateRules("approved", history.value, live.value);
  if (hit !== null) return fail("rule_still_fires", `${hit.reason} Exclude more runs, or run a new full batch.`);
  return appendHistory(
    deps,
    record.key,
    {
      event: "restored",
      at: d.at.toISOString(),
      by: d.staff,
      reason: o.note ?? `Restored after excluding runs (exclusion ${exclusion.at}).`,
      batch: null,
      exclusion: exclusion.at,
    },
    d.who,
  );
}

/** Sends a retired key back to `draft` (section 8 §10.9). It then needs a fresh batch and an approval. */
export function reinstateKey(
  deps: ScoreDeps,
  record: ScoreRecord,
  d: Decider,
  reason: string,
): Promise<Outcome<ScoreRecord, DecisionFailure>> {
  return staffMove(deps, record, "reinstate", d, { event: "reinstated", at: d.at.toISOString(), by: d.staff, reason });
}

/** Takes trust from an approved key (section 8 §4.2: a human demotes, rule `human`). */
export function demoteKey(
  deps: ScoreDeps,
  record: ScoreRecord,
  d: Decider,
  reason: string,
): Promise<Outcome<ScoreRecord, DecisionFailure>> {
  return staffMove(deps, record, "degrade", d, {
    event: "degraded",
    at: d.at.toISOString(),
    by: d.staff,
    reason,
    rule: "human",
    runs: [],
  });
}

/** Retires a key by hand, at any time, with a reason (section 8 §10.9). */
export function retireKey(
  deps: ScoreDeps,
  record: ScoreRecord,
  d: Decider,
  reason: string,
): Promise<Outcome<ScoreRecord, DecisionFailure>> {
  return staffMove(deps, record, "retire", d, {
    event: "retired",
    at: d.at.toISOString(),
    by: d.staff,
    reason,
    newer_key: null,
  });
}
