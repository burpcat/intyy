// What rungs 2 and 3 read and send: the deps a ladder needs for them, the masked inputs for jev
// and the reviewer, and the map from a reviewer's action to a gate action.
// Follows design section 5 §10.2 (jev's input), §11.1 (the reviewer's input), §11.2 (its output),
// section 4 §10 (the model sees the masked view), section 9 §5.3 (call order, masked inputs).
import type {
  CallRecorder,
  Classifier,
  JevTroubleInput,
  ModelElement,
  ReviewerAction,
  ReviewerInput,
  Reviewer,
} from "../../ports/models.js";
import type { Masked } from "../../ports/masked.js";
import type { ElementRef, Observation } from "../../ports/surface.js";
import type { Condition } from "../model/artifact/conditions.js";
import type { Handler } from "../model/pack.js";
import { buildScreen, childrenOf, maskedName, MAX_ELEMENTS } from "../discovery/observation.js";
import type { GateAction } from "../safety/gate/gate.js";
import { maskedInput } from "../safety/redaction/compose.js";
import type { Redactor } from "../safety/redaction/redactor.js";
import { CLICK_READY_MS } from "./act.js";
import type { Cutoffs } from "./jev-verdict.js";
import type { LadderStep, LadderTrouble } from "./ladder.js";

/** What a step says about itself that the models read but rung 1 does not (section 5 §10.2, `step`). */
export type StepFacts = { intent: string; action: string; timeoutMs: number };

/** A contract input the reviewer may type by reference: the raw value stays in memory (section 5 §11.1). */
export type InputFacts = { value: string; label: "pii" | "financial" | "none" };

/** The reviewer's own action types and keys, narrowed by policy by the caller (section 5 §11.1, `allowed`). */
export type AllowedFacts = {
  actions: readonly string[];
  keys: readonly string[];
  paths: readonly string[];
};

/**
 * Everything rungs 2 and 3 need besides the trouble. `jev` null: rung 2 is off. `reviewer` null:
 * rung 3 is off. The caller sets each from policy, the port, and `--models off` (section 5 §10.8).
 */
export type RungDeps = {
  jev: Classifier | null;
  reviewer: Reviewer | null;
  cutoffs: Pick<Cutoffs, "handler_min" | "outcome_min">;
  /**
   * Opens one model call's files in the run's `llm/` folder: a recorder that stores the request
   * first, then the reply, and the request file's relative path for the `ladder` line.
   */
  recorder: (who: "jev" | "reviewer") => { record: CallRecorder; request: string };
  /** Policy `llm.send_screenshots` (section 4 §10.5). Off: the reviewer's screenshot is null. */
  sendScreenshots: boolean;
  /** Per step ID, what the models read (intent, action type, timeout). */
  steps: ReadonlyMap<string, StepFacts>;
  /** Per contract input name, its raw value and label: the reviewer may type `{input.name}` only. */
  inputs: ReadonlyMap<string, InputFacts>;
  allowed: AllowedFacts;
  /** The commit state the reviewer is told (section 5 §11.1): `not_sent` or `confirmed`. */
  commit: () => "not_sent" | "confirmed";
  /** Reviewer calls used so far: on the stuck step, and in the run (section 5 §11.5). */
  reviewerCalls: { step: number; run: number };
  /** Told once per reviewer call, before the call: the caller counts it, whatever the call returns. */
  onReviewerCall: () => void;
  /** The number the next run-log line gets: the `seq:<n>` of a reviewer fix (section 5 §11.4). */
  nextSeq: () => number;
};

/** One step's facts for a model input: the step, why it failed, and where the run last stood. */
export type TroubleFacts = {
  r: Redactor;
  observation: Observation;
  step: LadderStep;
  stepIndex: number;
  steps: readonly LadderStep[];
  facts: StepFacts;
  trouble: LadderTrouble;
  conditions: ReadonlyMap<string, Condition> | undefined;
  lastGoodPath: string;
};

/** The masked screen both models read: location, an element list, and the IDs behind the list. */
function screenOf(o: Observation, r: Redactor) {
  const view = buildScreen(o, r);
  const kids = childrenOf(o.elements);
  const list = [...view.elements].map(([id, el]) => ({
    id,
    role: r.text(/^[a-z]+$/.test(el.role) ? el.role : "generic"),
    name: maskedName(r, el, kids) ?? r.text(""),
  }));
  return { location: view.location, truncated: view.ids.size >= MAX_ELEMENTS, list, refs: view.ids };
}

/** The parts jev and the reviewer share (section 5 §10.2, §11.1): `step`, `expected`, `last_good`. */
function sharedParts(f: TroubleFacts) {
  const condition = f.trouble.phase === "checkpoint" ? f.step.checkpoint : f.step.precondition;
  const description = f.conditions?.get(condition)?.description ?? condition;
  const previous = f.steps[f.stepIndex - 1];
  return {
    step: {
      id: f.step.id,
      intent: f.r.text(f.facts.intent),
      action: f.facts.action,
      risk: f.step.risk,
      phase: f.trouble.phase,
    },
    expected: {
      condition,
      description: f.r.text(description),
      // Why one entry: the evaluator gives no per-check trace yet. The failed condition is the trace.
      trace: [{ path: condition, check: "condition", passed: false }],
    },
    last_good:
      previous === undefined ? null : { step: previous.id, location: f.r.text(f.lastGoodPath) },
  };
}

/**
 * jev's step-trouble input (section 5 §10.2). Every text is masked. `handlers` is the whole frozen
 * set; `tied` is the handlers rung 1 could not choose between.
 */
export function jevTroubleInput(
  f: TroubleFacts,
  choices: {
    outcomes: readonly { code: string; description: string }[];
    handlers: readonly Handler[];
    tied: readonly string[];
  },
): Masked<JevTroubleInput> {
  const screen = screenOf(f.observation, f.r);
  const elements: ModelElement[] = screen.list.map((e) => ({ role: e.role, name: e.name }));
  return maskedInput<JevTroubleInput>({
    schema: "intyy.jev.step/1.0",
    ...sharedParts(f),
    screen: { location: screen.location, truncated: screen.truncated, elements },
    outcomes: choices.outcomes.map((o) => ({ code: o.code, description: f.r.text(o.description) })),
    handlers: choices.handlers.map((h) => ({
      id: h.id,
      class: h.class,
      description: f.r.text(h.description),
    })),
    tied: choices.tied,
  });
}

/** Base64 of some bytes, for the reviewer's screenshot field. Chunked so a big picture fits the stack. */
function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

/**
 * The reviewer's input (section 5 §11.1) and the element refs its IDs stand for. `shot` is the
 * masked screenshot, or null when withheld or not sent. `hint` is jev's bucket and confidence.
 */
export function reviewerInput(
  f: TroubleFacts,
  parts: {
    hint: ReviewerInput["jev"];
    inputs: readonly string[];
    allowed: AllowedFacts;
    commit: ReviewerInput["commit"];
    shot: Masked<Uint8Array> | null;
  },
): { input: Masked<ReviewerInput>; refs: ReadonlyMap<string, ElementRef> } {
  const screen = screenOf(f.observation, f.r);
  const input = maskedInput<ReviewerInput>({
    schema: "intyy.reviewer.step/1.0",
    ...sharedParts(f),
    screen: { location: screen.location, truncated: screen.truncated, elements: screen.list },
    jev: parts.hint,
    inputs: parts.inputs,
    allowed: parts.allowed,
    commit: parts.commit,
    screenshot: parts.shot === null ? null : base64(parts.shot),
  });
  return { input, refs: screen.refs };
}

/**
 * The gate action for one reviewer action (section 5 §11.2, §11.3), or null when it names an
 * element that is not on the screen. A `type` value that is exactly `{input.name}` of a known
 * input goes as that input; any other text goes as plain text, which the gate blocks for the
 * reviewer (section 4 §6.9, "type only `{input.*}`").
 */
export function reviewerGateAction(
  a: ReviewerAction,
  refs: ReadonlyMap<string, ElementRef>,
  inputs: ReadonlyMap<string, InputFacts>,
): GateAction | null {
  if (a.type === "press") return { type: "press", key: a.key, target: null };
  if (a.type === "navigate") return { type: "navigate", to: a.location };
  const target = refs.get(a.element);
  if (target === undefined) return null;
  switch (a.type) {
    case "click":
      return { type: "click", target, readinessTimeoutMs: CLICK_READY_MS };
    case "select":
      return { type: "select", target, option: a.value };
    case "set_checked":
      return { type: "set_checked", target, checked: a.checked };
    case "type": {
      const name = /^\{input\.([a-z0-9_]+)\}$/.exec(a.value)?.[1];
      const known = name === undefined ? undefined : inputs.get(name);
      if (name === undefined || known === undefined)
        return { type: "type", target, value: { kind: "text", text: a.value } };
      return { type: "type", target, value: { kind: "input", ref: `input.${name}`, text: known.value, label: known.label } };
    }
  }
}
