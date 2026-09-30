// Reconciliation: the read-only check that tells the truth about an uncertain commit, as a
// child run. Follows design section 7 §11 (reconciliation runs), section 2 §16.2 (the check),
// §16.6 (commit states), and section 5 §2.6 ("never end on `uncertain` while a check can run").
import type { z } from "zod";
import type { Artifact } from "../model/artifact.js";
import type { ContractInput, ContractOutput } from "../model/artifact/contract.js";
import { ReconciliationCheck } from "../model/artifact/recovery.js";
import type { ContractValue } from "../model/common.js";
import { Request } from "../model/request.js";
import type { Mode } from "../model/request.js";
import { resolveMajor } from "../catalog/capabilities.js";
import { resolveRefs } from "../targets/text.js";
import { runReplay, type ReplayDeps, type ReplayInput } from "./executor.js";

/** One `recovery.reconciliation.check` block (section 2 §16.2). */
type Check = z.infer<typeof ReconciliationCheck>;

/** Splits `app/capability@major`. The recovery block's own schema already enforces this shape,
 * so a mismatch here is a bug (only bugs throw, per CLAUDE.md). */
function splitCapabilityLink(link: string): { app: string; capability: string; major: number } {
  const m = /^([a-z][a-z0-9_-]*)\/([a-z][a-z0-9_]*)@([1-9]\d*)$/.exec(link);
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) {
    throw new Error(`splitCapabilityLink: ${link} does not fit app/capability@major`);
  }
  return { app: m[1], capability: m[2], major: Number(m[3]) };
}

/** One raw value, converted to its declared type (section 2 §12.2), the same rule the executor
 * already uses to read a step's own output back (section 3 §5.3). */
function convert(raw: string, type: ContractInput["type"]): ContractValue {
  if (type === "integer") return Number(raw);
  if (type === "boolean") return raw === "true";
  return raw;
}

/**
 * Builds the check capability's own request (section 2 §16.2: "Map from its inputs to our
 * values"). Every input the check artifact declares gets its ref resolved from the parent's
 * own known values; an input the map does not name is left out (the loader already checked
 * every one the check requires is mapped, at sealing time).
 */
export function buildCheckRequest(
  check: Check,
  checkArtifact: Artifact,
  refs: ReadonlyMap<string, string>,
  mode: Mode,
): Request {
  const inputs: Record<string, ContractValue> = {};
  for (const input of checkArtifact.contract.inputs) {
    const ref = check.inputs[input.name];
    if (ref === undefined) continue;
    inputs[input.name] = convert(resolveRefs(ref, refs), input.type);
  }
  return Request.parse({
    schema: "intyy.request/1.0",
    request_id: null,
    capability: check.capability,
    inputs,
    mode,
  });
}

/** A `check.outputs` reference: a whole value, never embedded in more text (section 2 §16.2,
 * "using `{result.*}`"). */
const RESULT_REF = /^\{result\.([a-z][a-z0-9_]*)\}$/;

/**
 * Builds our own outputs from the check's result (section 2 §16.2). `null` when a mapped
 * output cannot be resolved: "Found, but outputs missing" (section 7 §11.1), the caller's own
 * cue to end `outputs_unavailable` instead of `success`.
 */
export function mapCheckOutputs(
  check: Check,
  parentOutputs: readonly ContractOutput[],
  childOutputs: Readonly<Record<string, ContractValue>>,
): Record<string, ContractValue> | null {
  const typeOf = new Map(parentOutputs.map((o) => [o.name, o.type]));
  const out: Record<string, ContractValue> = {};
  for (const [ourName, ref] of Object.entries(check.outputs)) {
    const childName = RESULT_REF.exec(ref)?.[1];
    if (childName === undefined) return null;
    const value = childOutputs[childName];
    if (value === undefined) return null;
    const type = typeOf.get(ourName);
    out[ourName] = type === undefined ? value : convert(String(value), type);
  }
  return out;
}

/** What the reconciliation check found (section 7 §11.1, section 2 §16.2's own result table).
 * `unclear` covers both "anything else" and a run with no check to ask at all (a waiver, or no
 * `recovery.reconciliation` at all): in M06, rungs 2 and 3 (jev) are off, so both go straight
 * to a human (docs/decisions.md, M06). */
export type ReconciliationVerdict =
  | { kind: "found"; outputs: Record<string, ContractValue> }
  | { kind: "found_outputs_unavailable" }
  | { kind: "absent" }
  | { kind: "unclear" };

/** One reconciliation check's own answer, and the child run it ran as (`null` when no check
 * capability exists to ask at all: a waiver, or a candidate placeholder). */
export type ReconciliationRunResult = { verdict: ReconciliationVerdict; childRunId: string | null };

/**
 * Runs the linked check as a fresh child run (section 7 §11.1: "a child run, kind
 * `reconciliation`, with `parent_run_id`... in a new browser session, with its own prelude"),
 * and classifies its result. `parent` is the run asking; its own fields (tenant, policy,
 * settings, mode, and the rest) carry over unchanged, except `runId`, `request`, `frozenSet`,
 * and the child-run markers below.
 */
export async function runReconciliationCheck(
  parent: ReplayInput,
  parentArtifact: Artifact,
  refs: ReadonlyMap<string, string>,
  deps: ReplayDeps,
): Promise<ReconciliationRunResult> {
  const check = parentArtifact.recovery?.reconciliation?.check;
  if (check === undefined) return { verdict: { kind: "unclear" }, childRunId: null };
  const link = splitCapabilityLink(check.capability);
  const resolved = await resolveMajor(deps.artifacts, link.app, link.capability, link.major, parent.appVersion);
  if (!resolved.ok) return { verdict: { kind: "unclear" }, childRunId: null };
  const checkArtifact = resolved.value;
  // Why `supervised`: check 7 (section 3 §4.8) always rejects `unattended` in this build (no
  // score store yet, M10); the parent's own mode still governs its own escalations. No start
  // confirmation still applies (docs/decisions.md, M06: "child runs ask no start confirmation").
  const request = buildCheckRequest(check, checkArtifact, refs, "supervised");
  const childRunId = deps.ids.runId();
  // Named field by field, not `...parent`: the check's own frozen set (if any) is a different
  // capability's handlers, so the parent's own must not carry over (docs/decisions.md, M06).
  const childInput: ReplayInput = {
    runId: childRunId,
    request,
    tenant: parent.tenant,
    agentId: parent.agentId,
    policy: parent.policy,
    settings: parent.settings,
    appVersion: parent.appVersion,
    engineVersion: parent.engineVersion,
    outputsRevealed: parent.outputsRevealed,
    visible: parent.visible,
    parentRunId: parent.runId,
    kind: "reconciliation",
    purpose: "commit_check",
    isChildRun: true,
  };
  const childOutcome = await runReplay(childInput, deps);
  const r = childOutcome.result;
  if (r.status === "success") {
    const mapped = mapCheckOutputs(check, parentArtifact.contract.outputs, r.outputs);
    return {
      verdict: mapped === null ? { kind: "found_outputs_unavailable" } : { kind: "found", outputs: mapped },
      childRunId,
    };
  }
  if (r.status === "business_outcome" && check.not_found_outcomes.includes(r.outcome.code)) {
    return { verdict: { kind: "absent" }, childRunId };
  }
  return { verdict: { kind: "unclear" }, childRunId };
}
