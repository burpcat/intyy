// Reconciliation: the read-only check that tells the truth about an uncertain commit, as a
// child run. Follows design section 7 §11 (reconciliation runs), section 2 §16.2 (the check),
// §16.6 (commit states), and section 5 §2.6 ("never end on `uncertain` while a check can run").
import type { z } from "zod";
import type { Masked } from "../../ports/masked.js";
import type {
  CallRecorder,
  Classifier,
  JevReconcileInput,
  ModelElement,
  Reviewer,
} from "../../ports/models.js";
import type { LogLine } from "../orchestrator/run-log.js";
import { maskedInput } from "../safety/redaction/compose.js";
import type { Redactor } from "../safety/redaction/redactor.js";
import type { Artifact } from "../model/artifact.js";
import type { ContractInput, ContractOutput } from "../model/artifact/contract.js";
import { ReconciliationCheck } from "../model/artifact/recovery.js";
import type { ContractValue } from "../model/common.js";
import { Request } from "../model/request.js";
import type { Mode } from "../model/request.js";
import { resolveMajor } from "../catalog/capabilities.js";
import { resolveRefs } from "../targets/text.js";
import { runReplay, type ReplayDeps, type ReplayInput } from "./executor.js";
import { reconcileVerdict } from "./jev-verdict.js";

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

/** What the child check left behind, for jev and the second opinion (section 5 §10.5). The final
 * screen's elements come from the child's saved accessibility snapshot, already masked on disk;
 * every other text is raw and gets masked when the input is built. */
export type CheckFacts = {
  capability: string;
  status: string;
  outcome: string | null;
  failure: { code: string; step: string; phase: string; trace: { path: string; check: string; passed: boolean }[] } | null;
  finalScreen: { location: string; elements: ModelElement[] };
  notFoundOutcomes: readonly string[];
};

/** What the reconciliation check found (section 7 §11.1, section 2 §16.2's own result table).
 * `unclear` covers both "anything else" and a run with no check to ask at all (a waiver, or no
 * `recovery.reconciliation` at all). Plain code comes first; for "anything else" the caller may
 * ask jev and the second opinion (`check` holds what they read); otherwise it goes to a human. */
export type ReconciliationVerdict =
  | { kind: "found"; outputs: Record<string, ContractValue> }
  | { kind: "found_outputs_unavailable" }
  | { kind: "absent" }
  | { kind: "unclear"; check?: CheckFacts };

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
  return { verdict: { kind: "unclear", check: await checkFacts(check, r, deps, parent.tenant, childRunId) }, childRunId };
}

/** A line of the accessibility snapshot: `- role "name"` (the format `maskA11y` writes). */
const A11Y_LINE = /^\s*-\s+([a-zA-Z/]+)(?:\s+"((?:[^"\\]|\\.)*)")?/;

/** At most this many elements go to jev, like the screen list (section 5 §10.2, "Capped"). */
const MAX_FINAL_ELEMENTS = 150;

/** The child check's result as jev reads it (section 5 §10.5): status, outcome, failure with its
 * trace, and the last accessibility snapshot it saved. A missing snapshot gives no elements. */
async function checkFacts(
  check: Check,
  r: Awaited<ReturnType<typeof runReplay>>["result"],
  deps: ReplayDeps,
  tenant: string,
  childRunId: string,
): Promise<CheckFacts> {
  const failed = r.status === "failed" ? r.failure : null;
  let elements: ModelElement[] = [];
  const file = failed?.files.findLast((f) => /^a11y\/.*\.yaml$/.test(f));
  if (file !== undefined) {
    const folder = await deps.evidence.openRun(tenant, childRunId, deps.signal);
    const bytes = folder.ok ? await folder.value.readFile(file, deps.signal) : null;
    if (bytes?.ok === true) {
      elements = new TextDecoder()
        .decode(bytes.value)
        .split("\n")
        .flatMap((line) => {
          const m = A11Y_LINE.exec(line);
          return m?.[1] === undefined ? [] : [{ role: m[1], name: m[2] ?? "" }];
        })
        .slice(0, MAX_FINAL_ELEMENTS);
    }
  }
  return {
    capability: check.capability,
    status: r.status,
    outcome: r.status === "business_outcome" ? r.outcome.code : null,
    failure:
      failed === null
        ? null
        : {
            code: failed.code,
            step: failed.step ?? "",
            phase: failed.phase,
            trace: failed.observed.checks.map((c) => ({ path: c.path, check: c.check, passed: c.passed })),
          },
    finalScreen: { location: failed?.observed.location ?? "", elements },
    notFoundOutcomes: check.not_found_outcomes,
  };
}

/**
 * jev's and the second opinion's input for one unclear check (section 5 §10.5). `parent` is the
 * parent run's own last screen; `r` masks every free text. The final screen's elements are masked
 * on disk already, so they are not masked twice (section 4 §9.5).
 */
export function reconcileInput(
  r: Redactor,
  parent: {
    capability: string;
    commitStep: { id: string; intent: string };
    correlation: "notes" | "none";
    screen: { location: string; elements: ModelElement[] };
  },
  check: CheckFacts,
): Masked<JevReconcileInput> {
  return maskedInput<JevReconcileInput>({
    schema: "intyy.jev.reconcile/1.0",
    parent: {
      capability: parent.capability,
      commit_step: { id: parent.commitStep.id, intent: r.text(parent.commitStep.intent) },
      correlation: parent.correlation,
      last_screen: { location: r.text(parent.screen.location), elements: parent.screen.elements },
    },
    check: {
      capability: check.capability,
      status: check.status,
      outcome: check.outcome,
      failure:
        check.failure === null
          ? null
          : { code: check.failure.code, step: check.failure.step, phase: check.failure.phase, trace: check.failure.trace },
      final_screen: { location: r.text(check.finalScreen.location), elements: check.finalScreen.elements },
    },
    not_found_outcomes: check.notFoundOutcomes,
  });
}

/**
 * Anything else the check said: jev, then the reviewer's second opinion (section 5 §10.5, §10.6;
 * section 7 §11.1). Answers `found` only when both are sure (at `reconciliation_min` or more) and
 * agree. Everything else, including a missing or failed model, is `human`.
 * Why `not_found` is never accepted: only plain code may say nothing changed (CLAUDE.md); jev's
 * `not_found` asks for a person, who then decides any retry (section 5 §10.5).
 */
export async function reconcileWithModels(a: {
  jev: Classifier | null;
  reviewer: Reviewer | null;
  min: number;
  input: Masked<JevReconcileInput>;
  step: string;
  recorder: (who: "jev" | "reviewer") => { record: CallRecorder; request: string };
  log: (line: LogLine) => void;
  signal?: AbortSignal;
}): Promise<"found" | "human"> {
  const cutoffs = { reconciliation_min: a.min };
  const ask = async (who: "jev" | "reviewer", model: Classifier | Reviewer) => {
    const rec = a.recorder(who);
    const call =
      who === "jev"
        ? await (model as Classifier).reconcile(a.input, rec.record, a.signal)
        : await (model as Reviewer).secondOpinion(a.input, rec.record, a.signal);
    const v = reconcileVerdict(call, cutoffs);
    a.log({
      event: "reconciliation",
      step: a.step,
      by: who,
      data: { verdict: v.verdict, confidence: v.confidence, threshold: a.min, input: rec.request },
    });
    if (v.warning !== undefined) {
      a.log({ event: "warning", step: a.step, by: "engine", data: { code: v.warning, detail: `${who} gave no usable reconciliation answer` } });
    }
    return v;
  };
  if (a.jev === null) return "human";
  const first = await ask("jev", a.jev);
  // Why only `found` goes on: it is the only answer a model may settle (see above).
  if (first.verdict !== "found" || a.reviewer === null) return "human";
  const second = await ask("reviewer", a.reviewer);
  return second.verdict === "found" ? "found" : "human";
}
