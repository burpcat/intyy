// Loads a tiny hand-written log fixture for the recorder's rule tests (section 6 §18).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURES = fileURLToPath(new URL("../../fixtures/logs/", import.meta.url));

/** Reads and parses one `.jsonl` fixture under `tests/fixtures/logs/`, in file order. */
export function loadLog(name: string): unknown[] {
  const text = readFileSync(`${FIXTURES}${name}`, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}
