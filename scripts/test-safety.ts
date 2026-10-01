// Runs the safety and canary tests and writes the report to `<publish>/tests/safety.json`.
// Follows build plan section 10 §11.1 (item A12) and design section 4 §14, §15: the secret and
// member canaries still pass, and the known-limit test still runs, marked expected.
// Usage: npm run test:safety
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Config } from "../src/core/model/config.js";
import { buildSafetyReport, type VitestJson } from "../src/core/evidence/safety-report.js";

const root = join(import.meta.dirname, "..");

/** The test files and folders that make up "safety": the gate, redaction, canaries, secrets, the
 * pack canary, and the evidence publish checks. Live tests are out: they need the bank app. */
const FILTERS = ["tests/unit/safety", "tests/unit/packs/canary.test.ts", "tests/unit/evidence/"];

/** Runs Vitest on the unit project and returns its JSON report. */
function runVitest(): VitestJson {
  const dir = mkdtempSync(join(tmpdir(), "intyy-safety-"));
  const out = join(dir, "out.json");
  try {
    // Why the exit code is ignored: a failing test is still reported. This script sets its own.
    spawnSync("npx", ["vitest", "run", "--project", "unit", ...FILTERS, "--reporter=json", `--outputFile=${out}`], {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
    });
    return JSON.parse(readFileSync(out, "utf8")) as VitestJson;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(): void {
  const config = Config.parse(JSON.parse(readFileSync(join(root, "intyy.json"), "utf8")));
  const report = buildSafetyReport(runVitest(), root, new Date().toISOString());
  const out = join(root, config.publish, "tests", "safety.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const t = report.totals;
  console.log(`${String(t.passed)} passed, ${String(t.failed)} failed, ${String(t.expected_failures)} expected failure(s). Wrote ${relative(root, out)}.`);
  if (!report.success) {
    console.error(t.expected_failures === 0 ? "the known-limit test did not run" : "a safety test failed");
    process.exit(1);
  }
}

main();
