// Recorder step 9 (section 6 §14.2, §14.9): the commit point, and a placeholder recovery block.
import type { Recovery } from "../model/artifact/recovery.js";
import type { Step } from "../model/artifact/steps.js";
import type { RecorderIssue } from "./issues.js";

/**
 * The one step approved as irreversible, when the capability commits (section 6 §14.9).
 * `null`, plus a blocking issue, when there are zero or two such steps.
 */
export function pickCommitPoint(
  steps: readonly Step[],
  effect: "read_only" | "commits",
  issues: RecorderIssue[],
): string | null {
  if (effect !== "commits") return null;
  const irreversible = steps.filter((s) => s.risk === "irreversible");
  const first = irreversible[0];
  if (irreversible.length === 1 && first !== undefined) return first.id;
  issues.push({
    level: "blocking",
    code: "commit_point",
    message:
      irreversible.length === 0
        ? "No commit point: no step is flagged irreversible."
        : "More than one step is flagged irreversible; exactly one commit point is needed.",
  });
  return null;
}

/**
 * The `recovery` block, or `undefined` for a read-only capability (section 2 §16, §19.9's
 * candidate-mode note: `reconciliation` may be `null` until sealing needs a human link or a
 * waiver). The recorder can never pick the reconciliation capability itself (section 6 §14.9).
 */
export function buildRecovery(
  commitPoint: string | null,
  effect: "read_only" | "commits",
): Recovery | undefined {
  return effect === "commits" ? { commit_point: commitPoint, reconciliation: null } : undefined;
}
