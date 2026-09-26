// Runs the dependency-cruiser import rules over src/ and fails on any violation.
// Also proves each import rule and each lint rule fires on its own fixture.
// Follows build plan section 10 §5.3: "the rules run as one Vitest test".
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cruise } from "dependency-cruiser";
import extractDepcruiseOptions from "dependency-cruiser/config-utl/extract-depcruise-options";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
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

// Why: section 10 §5.3, "a self-test proves each rule fires". Each bad fixture breaks one rule.
test("each import rule reports its own fixture, and nothing else", async () => {
  const found = await findViolations(fileURLToPath(new URL("fixtures/", import.meta.url)));
  const pairs = found.map((v) => `${v.rule} <- ${v.from}`).sort();
  expect(pairs).toEqual([
    "adapters-only-from-wiring <- src/adapters/claude/bad-cross.ts",
    "adapters-only-from-wiring <- src/fakes/bad-adapter.ts",
    "core-no-world <- src/core/bad-world.ts",
    "hands-port-only-gate <- src/core/replay/bad-hands.ts",
    "harness-port-only-certify <- src/core/replay/bad-harness.ts",
  ]);
});

const maskedCast = 'type Masked<T> = T & { readonly m: true };\nexport const m = "x" as unknown as Masked<string>;\n';

/** One lint probe: code, where it pretends to live, and whether the rule must fire. */
interface LintProbe {
  code: string;
  file: string;
  fires: boolean;
}

const lintProbes: LintProbe[] = [
  { code: "export const t = Date.now();\n", file: "src/core/probe.ts", fires: true },
  { code: "export const t = new Date();\n", file: "src/core/probe.ts", fires: true },
  { code: "export const t = Date();\n", file: "src/core/probe.ts", fires: true },
  { code: "export const r = Math.random();\n", file: "src/core/probe.ts", fires: true },
  { code: "setTimeout(() => undefined, 1);\n", file: "src/core/probe.ts", fires: true },
  { code: "export const t = Date.now();\n", file: "src/cli/probe.ts", fires: false },
  { code: maskedCast, file: "src/cli/probe.ts", fires: true },
  { code: maskedCast, file: "src/core/probe.ts", fires: true },
  { code: maskedCast, file: "src/core/safety/redaction/probe.ts", fires: false },
];

// Why: section 10 §5.3, the two ESLint no-restricted-syntax rows. The probes never touch disk.
test.each(lintProbes)("no-restricted-syntax on $file fires=$fires: $code", async (probe) => {
  const eslint = new ESLint({ cwd: repoRoot, overrideConfig: tseslint.configs.disableTypeChecked });
  const results = await eslint.lintText(probe.code, { filePath: `${repoRoot}${probe.file}` });
  const ruleIds = results.flatMap((r) => r.messages.map((m) => m.ruleId));
  expect(ruleIds).toEqual(probe.fires ? ["no-restricted-syntax"] : []);
});
