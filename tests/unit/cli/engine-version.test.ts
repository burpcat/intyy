// Proves the engine version is 0.2.0 (docs/decisions.md, M08): M08 turns on the `region` and
// `image` clues, so the same inputs can vote differently (design section 7 §6.3: clue weights
// live in the engine, and every run logs the engine version).
import { expect, test } from "vitest";
import { readVersion } from "../../../src/cli/program.js";

test("readVersion returns 0.2.0", () => {
  expect(readVersion()).toBe("0.2.0");
});
