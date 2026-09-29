// Proves sensitivity.ts (section 6 §14.10): contract.inputs comes straight from the run spec.
import { describe, expect, test } from "vitest";
import { buildContractInputs } from "../../../src/core/recorder/sensitivity.js";

describe("buildContractInputs", () => {
  test("copies each spec input, always required", () => {
    expect(
      buildContractInputs([
        { name: "member_id", type: "string", description: "Member", sensitivity: "pii", example: "100107" },
      ]),
    ).toEqual([
      { name: "member_id", type: "string", description: "Member", required: true, sensitivity: "pii" },
    ]);
  });
});
