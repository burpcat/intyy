// The task block: what the LLM must do, in the masked view. It sits in the system prompt and
// never changes during a run. Follows design section 6 §8.1 (task block) and section 4 §10.2
// (what the discovery LLM gets): input names, not values; secret names only.
import type { Masked } from "../../ports/masked.js";
import type { RunSpec } from "../model/runspec.js";
import { masked } from "../safety/redaction/compose.js";
import type { Redactor } from "../safety/redaction/redactor.js";

/** One input as the LLM sees it. `value` is set only for inputs labelled `none`. */
export type InputView = {
  ref: Masked<string>;
  type: Masked<string>;
  description: Masked<string>;
  value: Masked<string> | null;
};

/** The task block's parts, each masked. */
export type TaskView = {
  kind: RunSpec["kind"];
  goal: Masked<string>;
  inputs: InputView[];
  outputs: { ref: Masked<string>; type: Masked<string>; description: Masked<string> }[];
  secrets: Masked<string>[];
  effect: RunSpec["expected_effect"];
  correlation: RunSpec["correlation"] | null;
  /** Negative runs: the outcome to reach, masked. */
  outcome: Masked<string> | null;
};

/**
 * Builds the task block. Every text passes the redactor, so a value typed into the goal by
 * mistake still leaves as its reference (section 4 §9.6). `secretNames` come from the app
 * policy's declared secrets (section 4 §8.2).
 */
export function taskView(spec: RunSpec, r: Redactor, secretNames: readonly string[]): TaskView {
  return {
    kind: spec.kind,
    goal: r.text(spec.goal),
    inputs: spec.inputs.map((i) => ({
      ref: r.text(`{input.${i.name}}`),
      type: r.text(i.type),
      description: r.text(i.description),
      value: r.noneValue(`input.${i.name}`),
    })),
    outputs: spec.outputs.map((o) => ({
      ref: r.text(`{output.${o.name}}`),
      type: r.text(o.type),
      description: r.text(o.description),
    })),
    secrets: [...secretNames].sort().map((n) => r.text(`{secret.${n}}`)),
    effect: spec.expected_effect,
    correlation: spec.correlation ?? null,
    outcome:
      spec.expected_outcome === undefined
        ? null
        : masked`${r.text(spec.expected_outcome.code)}: ${r.text(spec.expected_outcome.description)}`,
  };
}
