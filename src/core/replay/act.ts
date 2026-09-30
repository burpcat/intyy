// Acting: turns one artifact step's action into a gated proposal, voting for its target through
// findTarget, and answers with the gate's result, or the extracted value for `read`. Every acted
// step goes through the gate as actor `engine`; `read` never touches the hands (it is the eyes'
// job, section 9 §5.2). Follows design section 7 §6 (targets), §7 (acting), §7.2 (the dispatch
// check), §7.3 (transport failures, mapped to Outcome values; retries are M06). Native dialogs
// and pop-up windows need no extra code here: the eyes already model them as ordinary elements
// of the active window (section 7 §9, section 9 §5.2, M02), so findTarget and the gate act on
// them like any other control.
import type { Masked } from "../../ports/masked.js";
import type { Outcome } from "../../ports/outcome.js";
import type { LeaseToken, Observation } from "../../ports/surface.js";
import { readOutput } from "../discovery/read.js";
import type { ContractOutput } from "../model/artifact/contract.js";
import type { StepAction } from "../model/artifact/steps.js";
import type { Target } from "../model/artifact/targets.js";
import type {
  Gate,
  GateAction,
  GateFailure,
  GateResult,
  Proposal,
} from "../safety/gate/gate.js";
import type { RiskKind } from "../model/artifact/steps.js";
import type { Redactor } from "../safety/redaction/redactor.js";
import { resolveRefs } from "../targets/text.js";
import { findTarget, type TargetVoteFacts } from "./find-target.js";

/** The click readiness cap, normally, and on the commit step (section 7 §7.1). */
export const CLICK_READY_MS = 5_000;
export const CLICK_READY_COMMIT_MS = 2_000;

/** What acting on one step answers, besides the `target_vote` facts to log beside it.
 * `read`'s `raw` value is the capability's actual output (section 3 §5, "raw in memory for the
 * delivery window"): callers may hold it for the result, but must never log, print, or write it
 * unmasked; `masked` is what a log line takes instead (section 3 §6.4, `outputs_masked`). */
export type ActOutcome =
  | { kind: "acted"; gate: Outcome<GateResult, GateFailure> }
  | { kind: "read"; raw: string; masked: Masked<string> }
  | { kind: "read_failed"; detail: Masked<string> }
  | { kind: "target_not_found" }
  | { kind: "target_ambiguous" };

/** One step's acting result: the outcome, and the vote facts (null when the action names no
 * target, like `navigate` or `press`). */
export type ActStepResult = { outcome: ActOutcome; facts: TargetVoteFacts | null };

/** What acting on a step needs. `commitPoint` and `approval` pass straight to the gate's
 * `Proposal` (section 4 §7.8 checks 1 and 3); task 7 (the commit path) sets them. */
export type ActContext = {
  observation: Observation;
  targets: ReadonlyMap<string, Target>;
  /** `contract.outputs`, by name: `read`'s type, for conversion and the known-value kind. */
  outputs: ReadonlyMap<string, ContractOutput>;
  refs: ReadonlyMap<string, string> | undefined;
  redactor: Redactor;
  gate: Gate;
  lease: LeaseToken;
  stepId: string;
  commitPoint?: boolean;
  approval?: { by: string };
  /** The recorded risk and words a human confirmed at review, for the gate's live re-check
   * (section 4 §7.8 check 4). Task 7 (the commit path) sets this for the commit step. */
  confirmed?: { risk: RiskKind; words: readonly string[] };
  signal?: AbortSignal;
};

/** The named target. A missing one is a bug: the artifact loader already checks every step's
 * `target` field names a known target (mirrors `evaluate.ts`'s `voteFor`). */
function targetOf(ctx: ActContext, id: string): Target {
  const t = ctx.targets.get(id);
  if (t === undefined) throw new Error(`step action target ${id} is not a known target`);
  return t;
}

/** Proposes one action to the gate, as actor `engine` (section 4 §3.5). */
function propose(ctx: ActContext, action: GateAction): Promise<Outcome<GateResult, GateFailure>> {
  const p: Proposal = {
    actor: "engine",
    lease: ctx.lease,
    action,
    step: ctx.stepId,
    ...(ctx.commitPoint === true ? { commitPoint: true } : {}),
    ...(ctx.approval === undefined ? {} : { approval: ctx.approval }),
    ...(ctx.confirmed === undefined ? {} : { confirmed: ctx.confirmed }),
  };
  return ctx.gate.act(p, ctx.signal);
}

/** The named output. A missing one is a bug: the artifact loader checks every `read` step names
 * a declared output. */
function outputOf(ctx: ActContext, name: string): ContractOutput {
  const out = ctx.outputs.get(name);
  if (out === undefined) throw new Error(`read output ${name} is not a declared output`);
  return out;
}

/**
 * Acts on one artifact step (section 7 §7). `navigate` and `press` need no target; every other
 * action votes for its `target` through {@link findTarget} first. A `not_found` or `ambiguous`
 * vote never reaches the gate.
 */
export async function actStep(action: StepAction, ctx: ActContext): Promise<ActStepResult> {
  if (action.type === "navigate") {
    const gateAction: GateAction = { type: "navigate", to: action.location };
    return { outcome: { kind: "acted", gate: await propose(ctx, gateAction) }, facts: null };
  }
  if (action.type === "press") {
    const gateAction: GateAction = { type: "press", key: action.key, target: null };
    return { outcome: { kind: "acted", gate: await propose(ctx, gateAction) }, facts: null };
  }

  const found = findTarget(
    targetOf(ctx, action.target),
    ctx.observation,
    ctx.targets,
    ctx.refs,
    ctx.redactor,
  );
  if (found.kind !== "winner") {
    const kind = found.kind === "not_found" ? "target_not_found" : "target_ambiguous";
    return { outcome: { kind }, facts: found.facts };
  }
  const { ref, facts } = found;

  if (action.type === "read") {
    const el = ctx.observation.elements.find((e) => e.ref === ref);
    if (el === undefined) throw new Error("act: the winning ref is not in the observation");
    const out = outputOf(ctx, action.output);
    const got = readOutput(el, action.source, action.pattern, out.type, action.format);
    if (!got.ok) {
      return { outcome: { kind: "read_failed", detail: ctx.redactor.text(got.detail ?? "") }, facts };
    }
    // Why: section 3 §6.4 (docs/decisions.md, M03), an output becomes a known value once read,
    // so every later log line, snapshot, and screenshot masks it as its reference.
    ctx.redactor.addKnown({
      ref: `output.${action.output}`,
      value: got.value.value,
      label: "pii",
      type: out.type === "money" ? "money" : out.type === "date" ? "date" : "text",
      kind: out.type === "money" ? "money" : "account",
    });
    return {
      outcome: { kind: "read", raw: got.value.value, masked: ctx.redactor.text(got.value.value) },
      facts,
    };
  }

  const gateAction: GateAction = ((): GateAction => {
    switch (action.type) {
      case "click":
        return {
          type: "click",
          target: ref,
          readinessTimeoutMs: ctx.commitPoint === true ? CLICK_READY_COMMIT_MS : CLICK_READY_MS,
        };
      case "type":
        return {
          type: "type",
          target: ref,
          value: { kind: "text", text: resolveRefs(action.value, ctx.refs) },
        };
      case "select":
        return { type: "select", target: ref, option: resolveRefs(action.value, ctx.refs) };
      case "set_checked":
        return { type: "set_checked", target: ref, checked: action.checked };
    }
  })();
  return { outcome: { kind: "acted", gate: await propose(ctx, gateAction) }, facts };
}
