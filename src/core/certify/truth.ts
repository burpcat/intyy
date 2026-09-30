// Truth checks: plain code, run after the run ends, against the oracle or the baseline.
// Follows design section 8 §8.2; docs/decisions.md, M06: "output truth matches an oracle field
// of the same name, else unavailable."
import type { OracleAccount } from "../../ports/harness.js";
import type { ContractValue } from "../model/common.js";
import type { CommitState } from "../model/result.js";

/** One truth check's outcome. `null` means "unavailable": its truth source cannot answer, and
 * this never fails a run on its own (section 8 §8.2, "commit truth unavailable"). */
export type TruthResult = { match: boolean | null; note?: string };

/**
 * Commit truth, per attempt (section 8 §8.2's table). `oracleCount` is the oracle's `count` for
 * this attempt's own notes text. Two or more accounts is always `false`: a double commit.
 */
export function commitTruth(commit: CommitState, oracleCount: number): TruthResult {
  if (oracleCount >= 2) return { match: false, note: "the oracle found more than one account" };
  if (commit === "uncertain") return { match: true, note: "uncertain claims nothing" };
  const confirmedLike = commit === "confirmed" || commit === "found_by_check";
  return { match: confirmedLike ? oracleCount === 1 : oracleCount === 0 };
}

/**
 * The text to ask the oracle with: the notes input, its `{system.run_id}` reference filled with
 * this attempt's run ID (section 8 §8.2). `null` when the case names no `notes` input, so commit
 * truth cannot run at all ("with `correlation: none`, commit truth cannot run").
 */
export function notesQueryFor(inputs: Readonly<Record<string, ContractValue>>, runId: string): string | null {
  const raw = inputs.notes;
  return raw === undefined ? null : String(raw).replaceAll("{system.run_id}", runId);
}

/** The oracle account's own field of `name`, else `undefined` (docs/decisions.md, M06: "output
 * truth matches an oracle field of the same name, else unavailable"). Every field is a string,
 * so a plain `Record<string, unknown>` cast is never needed. */
function oracleField(oracle: OracleAccount, name: string): string | undefined {
  if (name === "account_number") return oracle.account_number;
  if (name === "status") return oracle.status;
  if (name === "confirmation_number") return oracle.confirmation_number;
  return undefined;
}

/**
 * Output truth for a `commits` capability (section 8 §8.2): each reported output against the
 * oracle field of the same name. Unavailable when the oracle found no matching field for any
 * reported output (docs/decisions.md, M06).
 */
export function outputTruthAgainstOracle(
  outputs: Readonly<Record<string, ContractValue>>,
  oracle: OracleAccount | undefined,
): TruthResult {
  if (oracle === undefined) return { match: null, note: "the oracle found no account to compare" };
  let compared = 0;
  let allMatch = true;
  for (const [name, value] of Object.entries(outputs)) {
    const truth = oracleField(oracle, name);
    if (truth === undefined) continue;
    compared += 1;
    if (truth !== String(value)) allMatch = false;
  }
  return compared === 0 ? { match: null, note: "unavailable: no oracle field of the same name" } : { match: allMatch };
}

/**
 * Output truth for a `read_only` capability (section 8 §8.2): the clean baseline's outputs are
 * the reference, since the same inputs after a reset give the same data (CONTRACT §5).
 */
export function outputTruthAgainstBaseline(
  outputs: Readonly<Record<string, ContractValue>>,
  baseline: Readonly<Record<string, ContractValue>>,
): TruthResult {
  const names = Object.keys(outputs);
  if (names.length === 0) return { match: null, note: "no outputs to compare" };
  const allMatch = names.every((name) => String(outputs[name]) === String(baseline[name]));
  return { match: allMatch };
}

/**
 * Outcome truth (section 8 §8.2): the reported `business_outcome` code must be the one the
 * case's class expects.
 */
export function outcomeTruth(reportedCode: string, expect: { status: string; outcome?: unknown }): TruthResult {
  if (expect.status !== "business_outcome") {
    return { match: false, note: `the class expects ${expect.status}, not business_outcome` };
  }
  return { match: expect.outcome === reportedCode };
}
