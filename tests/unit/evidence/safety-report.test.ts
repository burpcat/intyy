// Proves `buildSafetyReport`, the pure part of `npm run test:safety`: a test under a
// `describe("known limit …")` is marked an expected failure, the totals add up, `success` needs no
// failed test and at least one known-limit test, and the repo root is cut from file paths. Also
// proves the real known-limit test is still shaped the way the report expects.
// Build plan section 10 §11.1 (A12); design section 4 §14, §15.3. M07 task 10.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildSafetyReport, type VitestJson } from "../../../src/core/evidence/safety-report.js";
import { SafetyReport } from "../../../src/core/model/safety-report.js";

const ROOT = "/work/intyy";
const AT = "2026-02-01T10:00:00.000Z";

type Assertion = VitestJson["testResults"][number]["assertionResults"][number];
const t = (fullName: string, status: string, ancestorTitles: string[] = []): Assertion => ({ fullName, status, ancestorTitles });
const file = (name: string, status: string, ...tests: Assertion[]): VitestJson["testResults"][number] => ({
  name,
  status,
  assertionResults: tests,
});

const mixed: VitestJson = {
  testResults: [
    file(`${ROOT}/tests/unit/safety/a.test.ts`, "failed", t("a passes", "passed", ["a"]), t("a breaks", "failed", ["a"])),
    file(
      `${ROOT}/tests/unit/safety/redaction.test.ts`,
      "passed",
      t("known limit (x) a name leaks", "passed", ["known limit (x)"]),
      t("a later skip", "skipped"),
    ),
  ],
};

describe("buildSafetyReport", () => {
  test("buildSafetyReport marks the known-limit test, totals, success, paths, and status", () => {
    const r = buildSafetyReport(mixed, ROOT, AT);
    expect(SafetyReport.safeParse(r).success).toBe(true);
    const marked = r.files.flatMap((f) => f.tests).filter((x) => x.expected_failure === true);
    expect(marked.map((x) => x.name)).toEqual(["known limit (x) a name leaks"]);
    expect(r.totals).toEqual({ tests: 4, passed: 2, failed: 1, skipped: 1, expected_failures: 1 });
    expect(r.generated_at).toBe(AT);
    expect(buildSafetyReport(mixed, ROOT, AT).success).toBe(false);
    const names = (root: string): string[] => buildSafetyReport(mixed, root, AT).files.map((f) => f.file);
    expect(names(ROOT)).toEqual(["tests/unit/safety/a.test.ts", "tests/unit/safety/redaction.test.ts"]);
    expect(names(`${ROOT}/`)).toEqual(names(ROOT));
    expect(buildSafetyReport(mixed, ROOT, AT).files.map((f) => f.status)).toEqual(["failed", "passed"]);
  });

  test("success needs no failed test and a known-limit test", () => {
    const ok: VitestJson = {
      testResults: [
        file(`${ROOT}/tests/unit/safety/a.test.ts`, "passed", t("a passes", "passed", ["a"]), t("known limit (x) leak", "passed", ["known limit (x)"])),
      ],
    };
    expect(buildSafetyReport(ok, ROOT, AT).success).toBe(true);
    const none: VitestJson = { testResults: [file(`${ROOT}/tests/unit/safety/a.test.ts`, "passed", t("a passes", "passed", ["a"]))] };
    const r = buildSafetyReport(none, ROOT, AT);
    expect(r.totals.failed).toBe(0);
    expect(r.totals.expected_failures).toBe(0);
    expect(r.success).toBe(false);
  });

});

describe("the known-limit test the report marks", () => {
  test("the redaction tests keep a `known limit` describe holding a test.fails", () => {
    const source = readFileSync("tests/unit/safety/redaction.test.ts", "utf8");
    const at = source.indexOf('describe("known limit');
    expect(at).toBeGreaterThanOrEqual(0);
    const rest = source.slice(at + 1);
    const end = rest.indexOf("\ndescribe(");
    const block = end === -1 ? rest : rest.slice(0, end);
    expect(block).toContain("test.fails(");
    expect(block).toContain("a name inside a free sentence is masked");
  });
});
