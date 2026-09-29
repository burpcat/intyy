// Recorder step 10 (section 6 §14.2, §14.10): `contract.inputs`, straight from the run spec.
// `contract.outputs`' sensitivity default (money is `financial`, else `pii`) lives beside its
// own rule group, in `outputs.ts`.
import type { ContractInput } from "../model/artifact/contract.js";
import type { SpecInput } from "../model/runspec.js";

/**
 * `contract.inputs` (section 2 §12.2, section 6 §14.10: "Inputs: from the run spec"). A run spec
 * has no optional inputs, so every declared one is `required`.
 */
export function buildContractInputs(inputs: readonly SpecInput[]): ContractInput[] {
  return inputs.map((i) => {
    const out: ContractInput = {
      name: i.name,
      type: i.type,
      description: i.description,
      required: true,
      sensitivity: i.sensitivity,
    };
    if (i.constraints !== undefined) out.constraints = i.constraints;
    return out;
  });
}
