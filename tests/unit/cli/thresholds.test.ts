// Proves `intyy thresholds edit | check | seal | approve | show` (design section 9 §9.5, section 5
// §10.4, section 8 §14.1). Roles match faults: shared scope `*`, op_017 seals, op_031 approves.
// Temporary data roots only; the real library is never touched.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { call, cleanRoots, tempRoot } from "./helpers.js";

afterAll(cleanRoots);

const cli = (r: string, staff: string, argv: string[], extraEnv: Record<string, string> = {}) =>
  call(argv, { cwd: r, env: { INTYY_STAFF: staff, ...extraEnv }, deps: { commands } });

const APP = "kvfcu";
const JEV = ["--jev", "jev@fake"];

/** A clean record for `jev@fake`. */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "intyy.thresholds/1.0",
    app: APP,
    jev_version: "jev@fake",
    revision: 1,
    handler_min: 0.8,
    outcome_min: 0.95,
    reconciliation_min: 0.9,
    ...over,
  };
}

/** Runs `thresholds edit` with `doc` as the whole edited file (the `EDITOR: cp` trick). */
function editWith(r: string, doc: Record<string, unknown>): ReturnType<typeof cli> {
  const path = join(r, `edited-${String(Math.random()).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(doc));
  return cli(r, "op_017", ["thresholds", "edit", APP, ...JEV], { EDITOR: `cp "${path}"` });
}

describe("thresholds edit, check", () => {
  type Shown = {
    app: string;
    records: { jev_version: string; rev: string; state: string; handler_min: number }[];
  };

  test("show prints the starting values; bad edits and a missing --jev save nothing; a valid edit saves and check passes", async () => {
    const r = tempRoot();
    // show: with no record it prints the starting values
    const none = await cli(r, "op_017", ["thresholds", "show", APP]);
    expect(none.code).toBe(EXIT.ok);
    expect(none.stdout).toContain("starting values");
    for (const v of ["0.8", "0.95", "0.9"]) expect(none.stdout).toContain(v);
    expect(
      (JSON.parse((await cli(r, "op_017", ["thresholds", "show", APP, "--json"])).stdout) as Shown)
        .records,
    ).toEqual([]);

    // a bad edit (outcome_min below handler_min) saves nothing
    const edited = await editWith(r, body({ outcome_min: 0.5 }));
    expect(edited.code).toBe(EXIT.invalid);
    expect(edited.stderr).toContain("outcome_min");
    expect((await cli(r, "op_017", ["thresholds", "check", APP, ...JEV])).code).toBe(EXIT.usage);

    // a cutoff above 1 is refused
    expect((await editWith(r, body({ handler_min: 1.5 }))).code).not.toBe(EXIT.ok);
    expect((await cli(r, "op_017", ["thresholds", "check", APP, ...JEV])).code).toBe(EXIT.usage);

    // a missing --jev is a usage error
    for (const verb of ["edit", "check", "seal"]) {
      expect((await cli(r, "op_017", ["thresholds", verb, APP])).code, verb).toBe(EXIT.usage);
    }
    expect((await cli(r, "op_031", ["thresholds", "approve", APP, "--rev", "1"])).code).toBe(
      EXIT.usage,
    );

    // edit saves a valid candidate; check passes
    expect((await editWith(r, body())).code).toBe(EXIT.ok);
    expect((await cli(r, "op_017", ["thresholds", "check", APP, ...JEV])).code).toBe(EXIT.ok);
  });
});

describe("thresholds seal, approve: roles", () => {
  test("the sealer and op_022 (only two tenants, so the * scope refuses it) cannot approve; op_031 approves", async () => {
    const r = tempRoot();
    await editWith(r, body());
    expect((await cli(r, "op_017", ["thresholds", "seal", APP, ...JEV])).code).toBe(EXIT.ok);
    // the sealer cannot approve their own record
    const self = await cli(r, "op_017", ["thresholds", "approve", APP, ...JEV, "--rev", "1"]);
    expect(self.code).toBe(EXIT.refused);
    // op_022 approves only at two tenants, so the * scope refuses it
    const wrong = await cli(r, "op_022", ["thresholds", "approve", APP, ...JEV, "--rev", "1"]);
    expect(wrong.code).toBe(EXIT.refused);
    expect(
      (await cli(r, "op_031", ["thresholds", "approve", APP, ...JEV, "--rev", "1"])).code,
    ).toBe(EXIT.ok);
  });
});

describe("thresholds show", () => {
  type Shown = {
    app: string;
    records: { jev_version: string; rev: string; state: string; handler_min: number }[];
  };

  test("after approval it prints revision 1, approved", async () => {
    const r = tempRoot();
    await editWith(r, body({ handler_min: 0.85 }));
    await cli(r, "op_017", ["thresholds", "seal", APP, ...JEV]);
    await cli(r, "op_031", ["thresholds", "approve", APP, ...JEV, "--rev", "1"]);
    const shown = await cli(r, "op_017", ["thresholds", "show", APP, "--json"]);
    const rec = (JSON.parse(shown.stdout) as Shown).records;
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({
      jev_version: "jev@fake",
      rev: "1",
      state: "approved",
      handler_min: 0.85,
    });
    expect((await cli(r, "op_017", ["thresholds", "show", APP, ...JEV])).stdout).toContain(
      "rev 1 (approved)",
    );
  });
});

// Why a second version string: the real jev adapter reports `jev-1.13.0` (docs/decisions.md, M09,
// 2026-10-01), with a dash and dots and no `@`. Every verb must take it as the version folder.
describe("thresholds with the pinned jev version jev-1.13.0", () => {
  const PINNED = "jev-1.13.0";
  const PIN = ["--jev", PINNED];
  const pinnedBody = (over: Record<string, unknown> = {}) => body({ jev_version: PINNED, ...over });

  /** Like `editWith`, for the pinned version. */
  function editPinned(r: string, doc: Record<string, unknown>): ReturnType<typeof cli> {
    const path = join(r, `edited-pinned-${String(Math.random()).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(doc));
    return cli(r, "op_017", ["thresholds", "edit", APP, ...PIN], { EDITOR: `cp "${path}"` });
  }

  test("a bad edit (outcome_min below handler_min) saves nothing; a valid edit saves and check passes", async () => {
    const r = tempRoot();
    const edited = await editPinned(r, pinnedBody({ outcome_min: 0.5 }));
    expect(edited.code).toBe(EXIT.invalid);
    expect((await cli(r, "op_017", ["thresholds", "check", APP, ...PIN])).code).toBe(EXIT.usage);

    expect((await editPinned(r, pinnedBody())).code).toBe(EXIT.ok);
    expect((await cli(r, "op_017", ["thresholds", "check", APP, ...PIN])).code).toBe(EXIT.ok);
  });

  test("op_017 seals; the sealer cannot approve; op_031 approves", async () => {
    const r = tempRoot();
    await editPinned(r, pinnedBody());
    expect((await cli(r, "op_017", ["thresholds", "seal", APP, ...PIN])).code).toBe(EXIT.ok);
    expect(
      (await cli(r, "op_017", ["thresholds", "approve", APP, ...PIN, "--rev", "1"])).code,
    ).toBe(EXIT.refused);
    expect(
      (await cli(r, "op_031", ["thresholds", "approve", APP, ...PIN, "--rev", "1"])).code,
    ).toBe(EXIT.ok);
  });

  test("show lists the approved record under its version", async () => {
    const r = tempRoot();
    await editPinned(r, pinnedBody({ handler_min: 0.85 }));
    await cli(r, "op_017", ["thresholds", "seal", APP, ...PIN]);
    await cli(r, "op_031", ["thresholds", "approve", APP, ...PIN, "--rev", "1"]);
    const shown = await cli(r, "op_017", ["thresholds", "show", APP, "--json"]);
    const records = (JSON.parse(shown.stdout) as { records: { jev_version: string; rev: string; state: string; handler_min: number }[] }).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      jev_version: PINNED,
      rev: "1",
      state: "approved",
      handler_min: 0.85,
    });
    expect((await cli(r, "op_017", ["thresholds", "show", APP, ...PIN])).stdout).toContain(
      "rev 1 (approved)",
    );
  });
});
