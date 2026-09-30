// Proves `intyy pack edit | check | seal | second-look | dry-run` (design section 9 §8.5;
// section 5 §5.4, §6.7; docs/decisions.md, M06's pack auto-stamp and second-look rules). M06
// task 1.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import { call, cleanRoots, tempRoot } from "./helpers.js";

afterAll(cleanRoots);

const cli = (r: string, staff: string, argv: string[], extraEnv: Record<string, string> = {}) =>
  call(argv, { cwd: r, env: { INTYY_STAFF: staff, ...extraEnv }, deps: { commands } });

/** One clean global-scope pack body: `popup_handler` clicks `ok_button` when `popup_shown`. */
function packBody(risk: "idempotent" | "reversible" = "idempotent"): Record<string, unknown> {
  return {
    schema: "intyy.pack/1.0",
    scope: { level: "global" },
    revision: 1,
    reason: "A dismissible popup handler.",
    targets: [{ id: "ok_button", description: "OK button on the popup", clues: { role: "button", name: "OK" } }],
    conditions: [
      { id: "popup_shown", check: "element_visible", description: "The popup is showing", target: "ok_button" },
    ],
    handlers: [
      {
        id: "popup_handler",
        description: "A dismissible popup.",
        class: "recoverable",
        detector: "popup_shown",
        response: [{ type: "click", target: "ok_button", risk }],
        limits: { per_step: 1, per_run: 1 },
        on_exhausted: { class: "hard_failure", failure: "app_error" },
        fixtures: { fire: ["popup_fire_01"], no_fire: ["popup_near_miss_01"] },
      },
    ],
    provenance: { runs: [], decisions: [], sealed: null },
  };
}

/** Runs `pack edit global` with `body` as the whole edited file (the `EDITOR: cp` trick). */
async function editWith(r: string, staff: string, body: Record<string, unknown>): ReturnType<typeof cli> {
  const editedPath = join(r, `edited-${String(Math.random()).slice(2)}.json`);
  writeFileSync(editedPath, JSON.stringify(body));
  return cli(r, staff, ["pack", "edit", "global"], { EDITOR: `cp "${editedPath}"` });
}

/** Reads `library/packs/global/1.candidate.json` straight off disk. */
function readCandidate(r: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(r, "library", "packs", "global", "1.candidate.json"), "utf8")) as Record<string, unknown>;
}

/** `provenance.decisions`, each with its own `at` timestamp dropped, for a check that cares
 * about who decided what, never the exact clock time. */
function decisionsWithoutAt(cand: Record<string, unknown>): Record<string, unknown>[] {
  const decisions = (cand.provenance as { decisions: Record<string, unknown>[] }).decisions;
  return decisions.map((d) => ({ what: d.what, subject: d.subject, value: d.value, by: d.by }));
}

describe("pack edit: the auto-stamp (docs/decisions.md, M06)", () => {
  test("a new response-action risk gets a fresh risk decision, stamped by the editing staff", async () => {
    const r = tempRoot();
    const edited = await editWith(r, "op_017", packBody());
    expect(edited.code).toBe(EXIT.ok);
    expect(decisionsWithoutAt(readCandidate(r))).toEqual([
      { what: "risk", subject: "popup_handler.response[0]", value: "idempotent", by: "op_017" },
    ]);
  });

  test("an unchanged risk on a second edit adds no new stamp", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", packBody());
    const before = readCandidate(r);
    await editWith(r, "op_017", { ...packBody(), reason: "Widened the description only." });
    const after = readCandidate(r);
    expect((after.provenance as { decisions: unknown[] }).decisions).toEqual(
      (before.provenance as { decisions: unknown[] }).decisions,
    );
  });

  test("a changed risk gets a new stamp; the old one still stands in provenance", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", packBody("idempotent"));
    await editWith(r, "op_022", packBody("reversible"));
    expect(decisionsWithoutAt(readCandidate(r))).toEqual([
      { what: "risk", subject: "popup_handler.response[0]", value: "idempotent", by: "op_017" },
      { what: "risk", subject: "popup_handler.response[0]", value: "reversible", by: "op_022" },
    ]);
  });

  test("a forged provenance.decisions entry in the edited file is dropped, never trusted", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", packBody());
    const forged = {
      ...packBody(),
      provenance: {
        runs: [],
        decisions: [
          { what: "risk_second_look", subject: "popup_handler.response[0]", value: "idempotent", by: "someone_forged", at: "2020-01-01T00:00:00Z" },
        ],
        sealed: null,
      },
    };
    await editWith(r, "op_017", forged);
    const decisions = decisionsWithoutAt(readCandidate(r));
    expect(decisions.some((d) => d.by === "someone_forged")).toBe(false);
    expect(decisions).toEqual([
      { what: "risk", subject: "popup_handler.response[0]", value: "idempotent", by: "op_017" },
    ]);
  });
});

describe("pack check: loader checks only, no second-look needed", () => {
  test("a candidate with an unconfirmed risk still passes check", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", packBody());
    const got = await cli(r, "op_017", ["pack", "check", "global"]);
    expect(got.code).toBe(EXIT.ok);
  });
});

describe("pack seal: refuses an unstamped risk without a second look", () => {
  test("seal is refused until another reviewer agrees", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", packBody());
    const refused = await cli(r, "op_022", ["pack", "seal", "global"]);
    expect(refused.code).toBe(EXIT.invalid);
    expect(refused.stderr).toContain("missing_second_look");
  });

  test("second-look --agree by another staff, then seal succeeds", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", packBody());
    const looked = await cli(r, "op_022", ["pack", "second-look", "global", "popup_handler.response[0]", "--agree"]);
    expect(looked.code).toBe(EXIT.ok);
    const sealed = await cli(r, "op_022", ["pack", "seal", "global"]);
    expect(sealed.code).toBe(EXIT.ok);
  });

  test("second-look by the same staff who made the risk decision is refused", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", packBody());
    const looked = await cli(r, "op_017", ["pack", "second-look", "global", "popup_handler.response[0]", "--agree"]);
    expect(looked.code).toBe(EXIT.refused);
    expect(looked.stderr).toContain("another staff ID must give the second look");
  });

  test("--disagree records a dispute; seal still refuses", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", packBody());
    const disagreed = await cli(r, "op_022", ["pack", "second-look", "global", "popup_handler.response[0]", "--disagree"]);
    expect(disagreed.code).toBe(EXIT.ok);
    const sealed = await cli(r, "op_022", ["pack", "seal", "global"]);
    expect(sealed.code).toBe(EXIT.invalid);
  });
});

describe("pack dry-run --fixtures", () => {
  /** Writes one fixture folder directly (no discovery run needed for this offline check). */
  function writeFixture(r: string, id: string, a11y: string, location = "/home"): void {
    const dir = join(r, "library", "fixtures", "kvfcu", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        schema: "intyy.fixture/1.0",
        id,
        app: "kvfcu",
        tenant: "keystone",
        app_version: "9.2",
        variant: "keystone",
        location,
        viewport: { width: 1280, height: 800 },
        source: { run_id: "run_2026-09-30_f1x7pr3sd0", seq: 1 },
        kind: "trouble",
      }),
    );
    writeFileSync(join(dir, "a11y.yaml"), a11y);
  }

  test("shows which fixtures fire, and which do not, for the sealed pack", async () => {
    const r = tempRoot();
    await editWith(r, "op_017", packBody());
    await cli(r, "op_022", ["pack", "second-look", "global", "popup_handler.response[0]", "--agree"]);
    await cli(r, "op_022", ["pack", "seal", "global"]);
    writeFixture(r, "popup_fire_01", '- heading "x"\n- button "OK"');
    writeFixture(r, "quiet_home_01", '- heading "Welcome"');

    const got = await cli(r, "op_017", ["pack", "dry-run", "global", "--fixtures", "--json"]);
    expect(got.code).toBe(EXIT.ok);
    const rows = (JSON.parse(got.stdout) as { fixtures: { fixtureId: string; fires: string[] }[] }).fixtures;
    const byId = new Map(rows.map((row) => [row.fixtureId, row.fires]));
    expect(byId.get("popup_fire_01")).toEqual(["popup_handler"]);
    expect(byId.get("quiet_home_01")).toEqual([]);
  });
});
