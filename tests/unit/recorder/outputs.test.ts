// Proves outputs.ts step 7 (section 6 §14.7): `contract.outputs` from the spec, and one run's
// `extract` lines collected in order.
import { describe, expect, test } from "vitest";
import { buildContractOutputs, collectExtracts } from "../../../src/core/recorder/outputs.js";
import { loadLog } from "./helpers.js";

describe("collectExtracts", () => {
  test("collects one entry per extract line, in order", () => {
    const extracts = collectExtracts(
      "run_2026-09-24_0000000005",
      loadLog("read_output.jsonl"),
    );
    expect(extracts).toEqual([
      {
        runId: "run_2026-09-24_0000000005",
        seq: 2,
        output: "account_number",
        raw: "SH00219981",
        value: "SH00219981",
      },
    ]);
  });
});

describe("buildContractOutputs", () => {
  test("a money output is financial; anything else is pii by default", () => {
    const outputs = buildContractOutputs([
      { name: "account_number", type: "string", description: "The new account's number" },
      { name: "opening_balance", type: "money", description: "The account's opening balance" },
    ]);
    expect(outputs).toEqual([
      {
        name: "account_number",
        type: "string",
        description: "The new account's number",
        sensitivity: "pii",
      },
      {
        name: "opening_balance",
        type: "money",
        description: "The account's opening balance",
        sensitivity: "financial",
      },
    ]);
  });
});
