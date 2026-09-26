// Runs the dependency-cruiser import rules over src/ and fails on any violation.
// Follows build plan section 10 §5.3: "the rules run as one Vitest test".
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cruise } from "dependency-cruiser";
import extractDepcruiseOptions from "dependency-cruiser/config-utl/extract-depcruise-options";
import { expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** One broken rule: which rule, and the import that broke it. */
interface Violation {
  rule: string;
  from: string;
  to: string;
}

/** Cruises `src/` under `baseDir` with the repo's rules. Returns every violation. */
async function findViolations(baseDir: string): Promise<Violation[]> {
  if (!existsSync(`${baseDir}/src`)) return [];
  const options = await extractDepcruiseOptions(`${repoRoot}.dependency-cruiser.cjs`);
  const result = await cruise(["src"], { ...options, validate: true, baseDir });
  if (typeof result.output === "string") throw new Error("cruise returned text, not a result");
  return result.output.summary.violations.map((v) => ({ rule: v.rule.name, from: v.from, to: v.to }));
}

test("src/ follows every import rule", async () => {
  expect(await findViolations(repoRoot)).toEqual([]);
});
