// Recorder step 7 (section 6 §14.2, §14.7): `contract.outputs`, and each run's `extract` lines.
//
// Known limit: building the `read` step itself (its target and checkpoint) is not done here.
// Discovery's `read` tool never calls `captureFingerprint` for the read element (only `act()`
// does, for `click`/`type`/`select`/`set_checked`/`press`/`navigate`/`scroll`), so the log holds
// no clues for it. `sign_in`, this milestone's target, declares no outputs, so it does not need
// this yet. Recommended fix for the gap: have `doRead` in `src/core/discovery/loop.ts` capture a
// fingerprint too, the same way `act()` does.
import type { ContractOutput } from "../model/artifact/contract.js";
import type { SpecOutput, ValueType } from "../model/runspec.js";
import { parseLine } from "./log-lines.js";

/** One `extract` line, correlated with its run and turn. */
export type CollectedExtract = {
  runId: string;
  seq: number;
  output: string;
  raw: string;
  value: string;
};

/** Collects every `extract` line of one run, in log order (section 6 §14.7). */
export function collectExtracts(runId: string, rawLines: readonly unknown[]): CollectedExtract[] {
  const out: CollectedExtract[] = [];
  for (const raw of rawLines) {
    const line = parseLine(raw);
    if (line.kind === "extract") {
      out.push({ runId, seq: line.seq, output: line.data.output, raw: line.data.raw, value: line.data.value });
    }
  }
  return out;
}

/** The safest default label for one output type (section 6 §14.10): money is `financial`;
 * anything else is `pii`, since the word-list policy rule (section 4 §9.7) is a later task and,
 * when unsure, the worst label wins (section 4 §2.3). */
function defaultSensitivity(type: ValueType): "financial" | "pii" {
  return type === "money" ? "financial" : "pii";
}

/** `contract.outputs` (section 2 §12.5, section 6 §14.7): one entry per declared output, in
 * spec order. Types and descriptions come straight from the spec. */
export function buildContractOutputs(outputs: readonly SpecOutput[]): ContractOutput[] {
  return outputs.map((o) => ({
    name: o.name,
    type: o.type,
    description: o.description,
    sensitivity: defaultSensitivity(o.type),
  }));
}
