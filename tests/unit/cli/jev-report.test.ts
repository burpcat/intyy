// Proves `intyy jev report <app>` prints one row per jev answer type, all zero until M10 pools
// labelled calls, and that `jevTable` counts a small list correctly. Design section 9 §9.5 and
// section 8 §8.5.
import { afterAll, describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { ANSWER_TYPES, jevTable, type LabelledCall } from "../../../src/core/certify/jev-table.js";
import { call, cleanRoots, tempRoot } from "./helpers.js";

afterAll(cleanRoots);

type Report = { app: string; calls: number; rows: Record<string, unknown>[] };

describe("jev report", () => {
  test("prints 7 rows, all zero, with 0 calls", async () => {
    const r = tempRoot();
    const out = await call(["jev", "report", "kvfcu", "--json"], {
      cwd: r,
      env: { INTYY_STAFF: "op_017" },
      deps: { commands },
    });
    expect(out.code).toBe(EXIT.ok);
    const body = JSON.parse(out.stdout) as Report;
    expect(body.calls).toBe(0);
    expect(body.rows).toHaveLength(7);
    expect(body.rows.map((x) => x.answer)).toEqual([...ANSWER_TYPES]);
    for (const row of body.rows)
      expect(row).toMatchObject({ right: 0, wrong: 0, below_threshold: 0 });
  });

  test("a bad app ID is a usage error", async () => {
    const out = await call(["jev", "report", "Bad App"], {
      cwd: tempRoot(),
      env: { INTYY_STAFF: "op_017" },
      deps: { commands },
    });
    expect(out.code).toBe(EXIT.usage);
  });
});

describe("jevTable", () => {
  const c = (answer: LabelledCall["answer"], label: LabelledCall["label"]): LabelledCall => ({
    jev_version: "jev@fake",
    answer,
    label,
  });

  test("counts each label per answer type, and keeps every row", () => {
    const rows = jevTable([
      c("handler", "right"),
      c("handler", "right"),
      c("handler", "wrong"),
      c("outcome", "below_threshold"),
      c("found", "right"),
    ]);
    expect(rows).toHaveLength(7);
    const by = (a: string) => rows.find((x) => x.answer === a);
    expect(by("handler")).toEqual({ answer: "handler", right: 2, wrong: 1, below_threshold: 0 });
    expect(by("outcome")).toEqual({ answer: "outcome", right: 0, wrong: 0, below_threshold: 1 });
    expect(by("found")).toEqual({ answer: "found", right: 1, wrong: 0, below_threshold: 0 });
    expect(by("unsafe")).toEqual({ answer: "unsafe", right: 0, wrong: 0, below_threshold: 0 });
  });

  test("has no refused row: jev never claims it", () => {
    expect(ANSWER_TYPES).not.toContain("refused");
  });
});
