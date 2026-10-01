// Loader checks for `recovery`, `runs_on` portability, the session link, display formats, and
// the candidate-mode placeholders. Split out of `artifact-checks.ts`, which ran past 400 lines.
// Follows design section 2 §19.4 to §19.9, and section 6 §14.15 (blocking review issues).
import type { z } from "zod";
import type { Artifact } from "./artifact.js";
import type { ReconciliationCheck } from "./artifact/recovery.js";
import {
  type ArtifactCheckContext,
  type Facts,
  type Reporter,
  checkNamespace,
  matchesAnyPattern,
  scanRefs,
} from "./artifact-checks-shared.js";

const EFFECT_RECOVERY = "effect_recovery_mismatch";
const NO_COMMIT_POINT = "no_commit_point";
const COMMIT_MISMATCH = "commit_point_mismatch";
const MISSING_RECON = "missing_reconciliation";
const RECON_SHAPE = "reconciliation_shape";
const RECON_NOT_READONLY = "reconciliation_not_readonly";
const RECON_COUNT_SHAPE = "reconciliation_count_shape";

type ReconCheck = z.infer<typeof ReconciliationCheck>;
const COMPENSATED_NOT_COMMITS = "compensated_by_not_commits";
const MISSING_REFUSAL = "missing_refusal";
const LOCATION_NOT_IN_PATHS = "location_not_in_paths";
const POLICY_PATH_DENIED = "policy_path_denied";
const SESSION_LINK_INVALID = "session_link_invalid";
const DATE_READ_NEEDS_FORMAT = "date_read_needs_format";
const FORMAT_NOT_LISTED = "format_not_listed";
const NULL_VERSION = "null_version";
const NULL_SEALED = "null_sealed";
const EMPTY_ABOUT = "empty_about";
const UNDECIDED_TAG = "undecided_tag";

/** §19.4: `effect` and `recovery` agree, the commit point, reconciliation, and `compensated_by`. */
export function checkRecovery(
  artifact: Artifact,
  context: ArtifactCheckContext,
  facts: Facts,
  report: Reporter,
): void {
  const { effect } = artifact.contract;
  const { recovery } = artifact;
  if (effect === "commits" && recovery === undefined) {
    report(EFFECT_RECOVERY, "recovery", "a commits capability needs a recovery block");
    return;
  }
  if (effect === "read_only") {
    if (recovery !== undefined) report(EFFECT_RECOVERY, "recovery", "a read_only capability has no recovery block");
    if (artifact.steps.some((s) => s.risk === "irreversible")) {
      // Why blockable: an unsure step drafts as `irreversible` (section 4 §2.3), so a fresh
      // read_only candidate can legitimately start here. A human lowers it with a `risk`
      // decision, which then needs its own second look (section 6 §14.9, §14.15).
      report(EFFECT_RECOVERY, "steps", "a read_only capability has no irreversible step", true);
    }
    return;
  }
  if (recovery === undefined) return;

  const irreversible = artifact.steps.filter((s) => s.risk === "irreversible");
  if (irreversible.length !== 1) {
    report(NO_COMMIT_POINT, "recovery.commit_point", "exactly one step must be risk: irreversible", true);
  } else {
    const only = irreversible[0];
    if (only !== undefined) {
      if (recovery.commit_point === null) {
        report(NO_COMMIT_POINT, "recovery.commit_point", "no commit point is recorded yet", true);
      } else if (recovery.commit_point !== only.id) {
        report(
          COMMIT_MISMATCH,
          "recovery.commit_point",
          `names ${recovery.commit_point}, but ${only.id} is the irreversible step`,
        );
      } else {
        for (const code of only.outcomes) {
          const hasRefusal = artifact.provenance.decisions.some(
            (d) => d.what === "refusal" && d.subject === code,
          );
          if (!hasRefusal) {
            report(
              MISSING_REFUSAL,
              `steps.${only.id}.outcomes`,
              `outcome ${code} on the commit step has no refusal decision yet`,
              true,
            );
          }
        }
      }
    }
  }

  const recon = recovery.reconciliation;
  if (recon === null) {
    // Why "check needed": reconciliation is check-first; a waiver needs a failed attempt run
    // (owner decisions, 2026-10-01).
    report(
      MISSING_RECON,
      "recovery.reconciliation",
      "the commit point needs a linked reconciliation check (a recovery decision); a waiver needs a failed attempt_run",
      true,
    );
  } else {
    const hasCheck = recon.check !== undefined;
    const hasWaiver = recon.waiver !== undefined;
    if (hasCheck === hasWaiver) {
      report(RECON_SHAPE, "recovery.reconciliation", "must hold exactly one of check or waiver");
    } else if (hasCheck && recon.check !== undefined) {
      const cap = context.resolveCapability?.(recon.check.capability);
      if (context.resolveCapability !== undefined && (cap === undefined || cap.effect !== "read_only")) {
        report(
          RECON_NOT_READONLY,
          "recovery.reconciliation.check.capability",
          "the reconciliation capability must be read_only",
        );
      }
      checkCountShape(recon.check, report);
      Object.entries(recon.check.inputs).forEach(([k, v]) => {
        checkNamespace(v, new Set(["input", "system"]), `recovery.reconciliation.check.inputs.${k}`, facts, report);
      });
      Object.entries(recon.check.outputs).forEach(([k, v]) => {
        checkNamespace(v, new Set(["result"]), `recovery.reconciliation.check.outputs.${k}`, facts, report, cap?.outputs);
      });
    }
  }

  if (recovery.compensated_by !== undefined) {
    const cap = context.resolveCapability?.(recovery.compensated_by.capability);
    if (context.resolveCapability !== undefined && (cap === undefined || cap.effect !== "commits")) {
      report(
        COMPENSATED_NOT_COMMITS,
        "recovery.compensated_by.capability",
        "the compensating capability must be commits",
      );
    }
    Object.entries(recovery.compensated_by.inputs).forEach(([k, v]) => {
      checkNamespace(v, new Set(["output"]), `recovery.compensated_by.inputs.${k}`, facts, report);
    });
  }
}

/**
 * A `count_diff` check names one `count_output` and maps no `outputs` and no
 * `not_found_outcomes`: plain code decides from the count alone. A `reference` check names no
 * `count_output` (owner decisions, 2026-10-01).
 */
function checkCountShape(check: ReconCheck, report: Reporter): void {
  const path = "recovery.reconciliation.check";
  if (check.mode === "reference") {
    if (check.count_output !== undefined) report(RECON_COUNT_SHAPE, `${path}.count_output`, "only a count_diff check names a count_output");
    return;
  }
  if (check.count_output === undefined) report(RECON_COUNT_SHAPE, `${path}.count_output`, "a count_diff check needs a count_output");
  if (Object.keys(check.outputs).length > 0) report(RECON_COUNT_SHAPE, `${path}.outputs`, "a count_diff check maps no outputs");
  if (check.not_found_outcomes.length > 0) {
    report(RECON_COUNT_SHAPE, `${path}.not_found_outcomes`, "a count_diff check lists no not_found_outcomes");
  }
}

/** §19.5 and §19.6: `runs_on.entry`, every `navigate.location`, and the policy allowlist. */
export function checkPortability(artifact: Artifact, context: ArtifactCheckContext, report: Reporter): void {
  const { paths } = artifact.runs_on;
  if (!matchesAnyPattern(paths, artifact.runs_on.entry)) {
    report(LOCATION_NOT_IN_PATHS, "runs_on.entry", `${artifact.runs_on.entry} matches no pattern in runs_on.paths`);
  }
  artifact.steps.forEach((step, i) => {
    if (step.action.type === "navigate" && !matchesAnyPattern(paths, step.action.location)) {
      report(
        LOCATION_NOT_IN_PATHS,
        `steps[${String(i)}].action.location`,
        `${step.action.location} matches no pattern in runs_on.paths`,
      );
    }
  });
  if (context.pathAllowed !== undefined) {
    for (const p of paths) {
      if (!context.pathAllowed(p)) report(POLICY_PATH_DENIED, "runs_on.paths", `${p} sits outside the effective allowlist`);
    }
  }
}

/** §19.7: a non-null session link must name a read-only, input-free, output-free capability. */
export function checkSession(artifact: Artifact, context: ArtifactCheckContext, report: Reporter): void {
  const link = artifact.runs_on.session;
  if (link === null || context.resolveCapability === undefined) return;
  const cap = context.resolveCapability(link);
  const valid =
    cap !== undefined && cap.effect === "read_only" && cap.inputs.length === 0 && cap.outputs.length === 0 && cap.session === null;
  if (!valid) report(SESSION_LINK_INVALID, "runs_on.session", `${link} is not a valid session capability`);
}

/** §19.8: a `read` step for a `date` output needs a `format`, and formats come from the list. */
export function checkFormats(artifact: Artifact, context: ArtifactCheckContext, report: Reporter): void {
  const outputsByName = new Map(artifact.contract.outputs.map((o) => [o.name, o] as const));
  const inputsByName = new Map(artifact.contract.inputs.map((i) => [i.name, i] as const));
  artifact.steps.forEach((step, i) => {
    const { action } = step;
    const path = `steps[${String(i)}].action`;
    if (action.type === "read") {
      const out = outputsByName.get(action.output);
      if (out?.type === "date" && action.format === undefined) {
        report(DATE_READ_NEEDS_FORMAT, `${path}.format`, "a read step for a date output needs a format");
      }
      if (out !== undefined && action.format !== undefined) {
        const list = context.formatsFor?.(out.type);
        if (list !== undefined && !list.includes(action.format)) {
          report(FORMAT_NOT_LISTED, `${path}.format`, `${action.format} is not a listed format for ${out.type}`);
        }
      }
    }
    if (action.type === "type" && action.format !== undefined) {
      const inputRef = scanRefs(action.value).find((r) => r.ns === "input");
      const input = inputRef !== undefined ? inputsByName.get(inputRef.name) : undefined;
      if (input !== undefined) {
        const list = context.formatsFor?.(input.type);
        if (list !== undefined && !list.includes(action.format)) {
          report(FORMAT_NOT_LISTED, `${path}.format`, `${action.format} is not a listed format for ${input.type}`);
        }
      }
    }
  });
}

/**
 * The review-only gaps section 6 §14.15 names as blocking, and section 2 §19.9's placeholder
 * fields: no version, no seal, empty `about` text, and an undecided action tag.
 */
export function checkCandidatePlaceholders(artifact: Artifact, report: Reporter): void {
  if (artifact.identity.version === null) report(NULL_VERSION, "identity.version", "no version is set yet", true);
  if (artifact.provenance.sealed === null) report(NULL_SEALED, "provenance.sealed", "not sealed yet", true);
  for (const [field, value] of Object.entries(artifact.about)) {
    if (value === "") report(EMPTY_ABOUT, `about.${field}`, "is empty", true);
  }
  artifact.provenance.actions.forEach((action, i) => {
    if (action.human_tag === null || action.decided_by === null) {
      report(UNDECIDED_TAG, `provenance.actions[${String(i)}]`, "has no human tag yet", true);
    }
  });
}
