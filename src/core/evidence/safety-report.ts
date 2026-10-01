// Turns Vitest's JSON report into the safety report that `npm run test:safety` publishes.
// Follows build plan section 10 §11.1 (item A12) and design section 4 §14, §15 (the known-limit
// test passes by failing, and the report marks it expected). Pure: the script reads and writes files.
import { SafetyReport } from "../model/safety-report.js";

/** The slice of Vitest's JSON report this module reads. */
export type VitestJson = {
  testResults: {
    /** The test file's absolute path. */
    name: string;
    status: string;
    assertionResults: { fullName: string; ancestorTitles: string[]; status: string }[];
  }[];
};

/** Describe titles that start with this hold `test.fails` tests (section 4 §15). */
const KNOWN_LIMIT = "known limit";

/**
 * Builds the report. `root` is the repo folder, cut from each file path. `generatedAt` is an ISO
 * time from the caller. Failure text is dropped: it may quote test data. `success` needs no failed
 * test and at least one known-limit test, so a deleted known-limit test is a failure.
 */
export function buildSafetyReport(v: VitestJson, root: string, generatedAt: string): SafetyReport {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const files = v.testResults.map((f) => ({
    file: f.name.startsWith(prefix) ? f.name.slice(prefix.length) : f.name,
    status: f.status === "passed" ? ("passed" as const) : ("failed" as const),
    tests: f.assertionResults.map((t) => ({
      name: t.fullName,
      status:
        t.status === "passed" ? ("passed" as const) : t.status === "failed" ? ("failed" as const) : ("skipped" as const),
      ...(t.ancestorTitles.some((a) => a.startsWith(KNOWN_LIMIT)) ? { expected_failure: true as const } : {}),
    })),
  }));
  const all = files.flatMap((f) => f.tests);
  const count = (status: "passed" | "failed" | "skipped"): number => all.filter((t) => t.status === status).length;
  const totals = {
    tests: all.length,
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    expected_failures: all.filter((t) => t.expected_failure === true).length,
  };
  return SafetyReport.parse({
    schema: "intyy.safety_report/1.0",
    generated_at: generatedAt,
    success: totals.failed === 0 && totals.expected_failures > 0,
    totals,
    files,
  });
}
