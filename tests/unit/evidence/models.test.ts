// Proves the two new file formats parse a good file and reject an unknown key or a wrong schema
// name: the publish manifest (`intyy.publish/1.0`) and the safety report (`intyy.safety_report/1.0`).
// Design section 9 §6.6, build plan §11.1 (A12); section 3 §2 (strict schemas). M07 task 10.
import { describe, expect, test } from "vitest";
import { PublishManifest } from "../../../src/core/model/publish.js";
import { SafetyReport } from "../../../src/core/model/safety-report.js";

const HASH = `sha256:${"a".repeat(64)}`;

const manifest = (): Record<string, unknown> => ({
  schema: "intyy.publish/1.0",
  items: [
    { kind: "run", id: "run_2026-01-15_aaaaaaaaaa", tenant: "keystone" },
    { kind: "artifact", id: "kvfcu/open_sub@1.0.0", hash: HASH },
  ],
  by: "op_017",
  at: "2026-02-01T10:00:00.000Z",
  source_hashes: { "keystone/runs/run_2026-01-15_aaaaaaaaaa/run.json": HASH },
});

const report = (): Record<string, unknown> => ({
  schema: "intyy.safety_report/1.0",
  generated_at: "2026-02-01T10:00:00.000Z",
  success: true,
  totals: { tests: 2, passed: 2, failed: 0, skipped: 0, expected_failures: 1 },
  files: [
    {
      file: "tests/unit/safety/redaction.test.ts",
      status: "passed",
      tests: [
        { name: "a plain test", status: "passed" },
        { name: "known limit a name inside a free sentence is masked", status: "passed", expected_failure: true },
      ],
    },
  ],
});

describe("PublishManifest", () => {
  test("a good manifest parses", () => {
    expect(PublishManifest.safeParse(manifest()).success).toBe(true);
  });
  test("an unknown key is rejected, at the top and inside an item", () => {
    expect(PublishManifest.safeParse({ ...manifest(), extra: 1 }).success).toBe(false);
    const m = manifest();
    (m.items as Record<string, unknown>[])[0] = { kind: "run", id: "x", tenant: "keystone", extra: 1 };
    expect(PublishManifest.safeParse(m).success).toBe(false);
  });
  test("a wrong schema name, a bad hash, and a bad item kind are rejected", () => {
    expect(PublishManifest.safeParse({ ...manifest(), schema: "intyy.publish/2.0" }).success).toBe(false);
    expect(PublishManifest.safeParse({ ...manifest(), source_hashes: { a: "sha256:abc" } }).success).toBe(false);
    expect(PublishManifest.safeParse({ ...manifest(), items: [{ kind: "trust", id: "x" }] }).success).toBe(false);
  });
});

describe("SafetyReport", () => {
  test("a good report parses", () => {
    expect(SafetyReport.safeParse(report()).success).toBe(true);
  });
  test("an unknown key is rejected, at the top, in totals, and in a test", () => {
    expect(SafetyReport.safeParse({ ...report(), extra: 1 }).success).toBe(false);
    expect(SafetyReport.safeParse({ ...report(), totals: { ...(report().totals as object), extra: 1 } }).success).toBe(false);
    const r = report();
    ((r.files as { tests: Record<string, unknown>[] }[])[0]?.tests ?? [])[0] = { name: "t", status: "passed", failure: "text" };
    expect(SafetyReport.safeParse(r).success).toBe(false);
  });
  test("a wrong schema name or status is rejected", () => {
    expect(SafetyReport.safeParse({ ...report(), schema: "intyy.safety_report/2.0" }).success).toBe(false);
    const r = report();
    ((r.files as { tests: Record<string, unknown>[] }[])[0]?.tests ?? [])[0] = { name: "t", status: "todo" };
    expect(SafetyReport.safeParse(r).success).toBe(false);
  });
});
