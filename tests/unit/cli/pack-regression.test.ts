// Proves `pack impact`, the regression coverage rule on `pack approve`, and `certify --kind regression
// --pack ... --all-affected` (design section 8 §15.1, §15.2; section 9 §8.5, §9.1; section 8 §7.1):
// impact lists the approved keys whose frozen handler set hash would change; with none, approval is
// as before; with some, `pack approve` (role checked first) refuses with exit 6 naming the key until a
// regression batch line exists that passed its gate, was no drill, and ran under the new hash; a
// regression batch runs the candidate revision only (live runs keep the old hash), carries no timeouts,
// stability, or drills, and writes no demotion when its gate fails. Temporary data roots, the
// route-mapping harness double. M11 task 5.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { EXIT } from "../../../src/cli/exit-codes.js";
import type { BatchPlan } from "../../../src/core/model/batch-plan.js";
import type { BatchReport } from "../../../src/core/model/batch-report.js";
import { Pack, type PackScope } from "../../../src/core/model/pack.js";
import { packScopeId } from "../../../src/core/model/pack.js";
import { HistoryLine } from "../../../src/core/model/score-history.js";
import { ScoreRecord, type ScoreKey } from "../../../src/core/model/score.js";
import { buildFrozenSet } from "../../../src/core/packs/merge.js";
import { keyPath } from "../../../src/core/trust/keys.js";
import { rebuild } from "../../../src/core/trust/rebuild.js";
import { approved, batch, HASHES } from "../trust/kit.js";
import { CAP, certifyCall, editWith, sealQuickInputs } from "./certify-kit.js";
import { cleanRoots } from "./helpers.js";
import { realWiringOf, replayRoot, type ReplayEnv } from "./replay-harness.js";

afterAll(cleanRoots);

const LONG = { timeout: 120_000 };
const APP_SCOPE: PackScope = { level: "app", app: "kvfcu" };
const KEY: ScoreKey = { capability: "kvfcu/open_sub@1.0.0", tenant: "keystone", app_version: "8.4", patch_revision: null };

function handler(id: string): Record<string, unknown> {
  return {
    id,
    description: "A dismissible popup.",
    class: "recoverable",
    detector: "popup_shown",
    response: [{ type: "click", target: "ok_button", risk: "idempotent" }],
    limits: { per_step: 1, per_run: 1 },
    on_exhausted: { class: "hard_failure", failure: "app_error" },
    fixtures: { fire: [`${id}_fire`], no_fire: [`${id}_near_miss`] },
  };
}

function appPack(revision: number, handlers: string[]): Pack {
  return Pack.parse({
    schema: "intyy.pack/1.0",
    scope: APP_SCOPE,
    revision,
    reason: "A test pack.",
    targets: [{ id: "ok_button", description: "OK button", clues: { role: "button", name: "OK" } }],
    conditions: [{ id: "popup_shown", check: "element_visible", description: "The popup is showing", target: "ok_button" }],
    handlers: handlers.map(handler),
    provenance: { runs: [], decisions: [], sealed: null },
  });
}

/** Seals `doc` as op_017 in the real pack store; approves it as op_031 when `approve` is set. */
async function putPack(env: ReplayEnv, doc: Pack, approve: boolean): Promise<void> {
  const packs = realWiringOf(env).packs;
  const id = packScopeId(APP_SCOPE);
  const put = await packs.putCandidate(id, doc, "op_017");
  if (!put.ok) throw new Error(`test setup: putCandidate failed: ${put.detail ?? ""}`);
  const sealed = await packs.seal(id, "op_017");
  if (!sealed.ok) throw new Error(`test setup: seal failed: ${sealed.detail ?? ""}`);
  if (approve && !(await packs.approve(id, sealed.value.rev, "op_031")).ok) throw new Error("test setup: approve failed");
}

/** The frozen set hash of the live set (rev 1) and of the candidate (rev 2), built here so these tests do not lean on `pack impact`. */
function hashes(): { before: string; after: string } {
  const hashOf = (revision: number, handlers: string[]): string => {
    const set = buildFrozenSet([{ scope: APP_SCOPE, revision, pack: appPack(revision, handlers) }], { appVersion: "8.4" });
    if (!set.ok) throw new Error("test setup: frozen set did not build");
    return set.value.runStart.hash;
  };
  return { before: hashOf(1, ["popup_one"]), after: hashOf(2, ["popup_one", "popup_two"]) };
}

/** Writes the lines to the key's history, then its record, as the live system would have. */
async function seedKey(env: ReplayEnv, lines: HistoryLine[]): Promise<void> {
  const scores = realWiringOf(env).scores;
  for (const l of lines) if (!(await scores.append(keyPath(KEY), l)).ok) throw new Error("test setup: append failed");
  const rebuilt = rebuild(KEY, HASHES, lines);
  if (!rebuilt.ok || !(await scores.putRecord(keyPath(KEY), rebuilt.value)).ok) throw new Error("test setup: putRecord failed");
}

/** A root with app pack rev 1 approved (one handler) and rev 2 sealed (adds a handler). `key`: an approved key exists. */
async function packRoot(key: boolean, extraLines: HistoryLine[] = []): Promise<ReplayEnv> {
  const env = await replayRoot();
  await putPack(env, appPack(1, ["popup_one"]), true);
  await putPack(env, appPack(2, ["popup_one", "popup_two"]), false);
  if (key) await seedKey(env, [approved(1), ...extraLines]);
  return env;
}

type Impact = { pack: string; impacted: { tenant: string; key: string; before: string | null; after: string | null }[] };
async function impact(env: ReplayEnv): Promise<Impact> {
  const r = await certifyCall(env, "op_017", ["pack", "impact", "app:kvfcu", "2", "--json"]);
  expect(r.code).toBe(EXIT.ok);
  return JSON.parse(r.stdout) as Impact;
}
const approve = (env: ReplayEnv, staff = "op_031") => certifyCall(env, staff, ["pack", "approve", "app:kvfcu", "--rev", "2"]);

/** A `regression` batch line under `handlerSet`. */
function regression(handlerSet: string | null, over: Partial<Extract<HistoryLine, { event: "batch" }>> = {}): HistoryLine {
  return batch(3, "batch_reg", {
    kind: "regression",
    gate: "passed",
    under: { engine: "0.4.0", handler_set: handlerSet ?? "", jev: null, session: null, check: null },
    ...over,
  });
}

describe("pack impact", () => {
  test("lists the approved key whose handler set hash changes, with both hashes", async () => {
    const env = await packRoot(true);
    const found = await impact(env);
    expect(found.impacted).toHaveLength(1);
    expect(found.impacted[0]).toMatchObject({ tenant: "keystone", key: "kvfcu/open_sub@1.0.0" });
    expect(found.impacted[0]?.before).toMatch(/^sha256:/);
    expect(found.impacted[0]?.after).toMatch(/^sha256:/);
    expect(found.impacted[0]?.after).not.toBe(found.impacted[0]?.before);
    const text = (await certifyCall(env, "op_017", ["pack", "impact", "app:kvfcu", "2"])).stdout;
    expect(text).toContain("kvfcu/open_sub@1.0.0");
  });

  test("with no approved key, it says none is touched; a draft key is not touched", async () => {
    for (const key of [false, true]) {
      const env = await replayRoot();
      await putPack(env, appPack(1, ["popup_one"]), true);
      await putPack(env, appPack(2, ["popup_one", "popup_two"]), false);
      if (key) await seedKey(env, [batch(1, "batch_a")]);
      const r = await certifyCall(env, "op_017", ["pack", "impact", "app:kvfcu", "2"]);
      expect(r.code).toBe(EXIT.ok);
      expect(r.stdout).toContain("no approved key is touched");
    }
  });

  test("a sealed revision that changes nothing touches nothing", async () => {
    const env = await replayRoot();
    await putPack(env, appPack(1, ["popup_one"]), true);
    await putPack(env, { ...appPack(2, ["popup_one"]), reason: "Only the reason changed." }, false);
    await seedKey(env, [approved(1)]);
    expect((await impact(env)).impacted).toEqual([]);
  });
});

describe("pack approve: the regression coverage rule", () => {
  test("no approved key is touched: approve succeeds as before", async () => {
    const env = await packRoot(false);
    expect((await approve(env)).code).toBe(EXIT.ok);
  });

  test("an approved key is touched and uncovered: exit 6 naming the key and the command; nothing is approved", async () => {
    const env = await packRoot(true);
    const r = await approve(env);
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toContain("kvfcu/open_sub@1.0.0");
    expect(r.stderr).toContain("kvfcu/open_sub@1.0.0");
    // The command it tells the approver to run must be one the CLI takes: scope `app:kvfcu`, not the store ID `app/kvfcu`.
    expect.soft(r.stderr).toContain("--pack app:kvfcu@2");
    // Still refused on a second try: the refusal wrote nothing.
    expect((await approve(env)).code).toBe(EXIT.refused);
  });

  test("a non-approver gets the role error first, not the key list", async () => {
    const env = await packRoot(true);
    const r = await approve(env, "op_017");
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).not.toContain("kvfcu/open_sub@1.0.0");
  });

  test.each([
    ["a failed gate", (h: string) => regression(h, { gate: "failed" })],
    ["a drill", (h: string) => regression(h, { drill: true })],
    ["another hash", () => regression("sha256:" + "ab".repeat(32))],
    ["a full batch, not a regression", (h: string) => regression(h, { kind: "full" })],
  ])("%s does not cover the key", async (_name, line) => {
    const env = await packRoot(true);
    const { after } = hashes();
    await seedExtra(env, line(after));
    const r = await approve(env);
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toContain("kvfcu/open_sub@1.0.0");
  });

  test("a passed, non-drill regression under the new hash covers it: approve succeeds", async () => {
    const env = await packRoot(true);
    const { after } = hashes();
    await seedExtra(env, regression(after));
    expect((await approve(env)).code).toBe(EXIT.ok);
  });
});

/** Appends one more history line to the seeded key, and rewrites its record from the whole history. */
async function seedExtra(env: ReplayEnv, line: HistoryLine): Promise<void> {
  const scores = realWiringOf(env).scores;
  if (!(await scores.append(keyPath(KEY), line)).ok) throw new Error("test setup: append failed");
  const all = await scores.history(keyPath(KEY));
  if (!all.ok) throw new Error("test setup: history failed");
  const rebuilt = rebuild(KEY, HASHES, all.value);
  if (!rebuilt.ok || !(await scores.putRecord(keyPath(KEY), rebuilt.value)).ok) throw new Error("test setup: putRecord failed");
}

// --- certify --kind regression --------------------------------------------------------------------------

type Batches = { pack: string; batches: { batch_id: string; plan: BatchPlan; report: BatchReport }[]; other_tenants: string[] };

/** The quick kit's suite and test data, and a fault set whose faults all recover (so a batch passes) or the kit's own (so it fails). */
async function certifyReady(faults: "recovering" | "kit", key = true): Promise<ReplayEnv> {
  const env = await packRoot(false);
  await sealQuickInputs(env, faults === "recovering" ? "faults" : undefined);
  if (faults === "recovering") {
    await editWith(env, "op_017", ["faults", "edit", "kvfcu"], {
      schema: "intyy.faults/1.0",
      app: "kvfcu",
      revision: 1,
      profiles: [{ id: "server_error", kind: "server_error", at: "@each_request_step", expect_commit: "recovers", expect_window: "recovers" }],
    });
    await certifyCall(env, "op_017", ["faults", "seal", "kvfcu"]);
    await certifyCall(env, "op_031", ["faults", "approve", "kvfcu", "--rev", "1"]);
  }
  if (key) await seedKey(env, [approved(1)]);
  return env;
}

const REGRESSION = ["certify", "--kind", "regression", "--pack", "app:kvfcu@2", "--all-affected", "--json"];
const history = (env: ReplayEnv): HistoryLine[] =>
  readFileSync(join(env.root, "state", "trust", "scores", keyPath(KEY), "history.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => HistoryLine.parse(JSON.parse(l)));
const record = (env: ReplayEnv): ScoreRecord =>
  ScoreRecord.parse(JSON.parse(readFileSync(join(env.root, "state", "trust", "scores", keyPath(KEY), "record.json"), "utf8")));

describe("certify --kind regression --pack --all-affected", () => {
  test("one regression batch for the one affected key: plan, report, and history line", LONG, async () => {
    const env = await certifyReady("recovering");
    const found = hashes();
    const r = await certifyCall(env, "op_017", REGRESSION);
    expect(r.code).toBe(EXIT.ok);
    const body = JSON.parse(r.stdout) as Batches;
    expect.soft(body.pack).toBe("app:kvfcu@2");
    expect(body.batches).toHaveLength(1);
    const [b] = body.batches;
    if (b === undefined) throw new Error("no batch");
    expect(b.plan).toMatchObject({ kind: "regression", capability: CAP });
    expect(b.report).toMatchObject({ kind: "regression", gate: { passed: true } });
    // The pack is named the way the command takes it (section 9 §9.1): `app:kvfcu@2`, never the store ID `app/kvfcu@2`.
    expect.soft(b.plan.pack).toBe("app:kvfcu@2");
    expect.soft(b.report.pack).toBe("app:kvfcu@2");
    // No drills, no stability, no timeouts (section 8 §7.1, §15.1).
    expect(b.plan.cases.some((c) => c.case_id.startsWith("drill"))).toBe(false);
    expect(b.plan.cases.some((c) => c.case_id.startsWith("stab"))).toBe(false);
    expect(b.plan.drill).toBeUndefined();
    expect(b.report.stability ?? null).toBeNull();
    expect(b.report.timeouts).toBeUndefined();

    const lines = history(env);
    expect(lines.map((l) => l.event)).toEqual(["approved", "batch"]);
    const line = lines[1];
    if (line?.event !== "batch") throw new Error("expected a batch line");
    expect(line).toMatchObject({ kind: "regression", gate: "passed", batch: b.batch_id });
    expect(line.drill).toBeUndefined();
    expect(line.scores).toBeNull();
    // It ran under the candidate's hash, so it covers the pack for this key.
    expect(line.under.handler_set).toBe(found.after);
    expect(line.under.handler_set).not.toBe(found.before);
    expect(record(env).state).toBe("approved");
  });

  test("the batch's runs freeze the candidate hash, while the live frozen set stays unchanged", LONG, async () => {
    const env = await certifyReady("recovering");
    const found = hashes();
    const r = await certifyCall(env, "op_017", REGRESSION);
    const first = (JSON.parse(r.stdout) as Batches).batches[0]?.plan.cases[0];
    const runJson = await realWiringOf(env).evidence.readRunJson("keystone", first?.run_id ?? "");
    if (!runJson.ok) throw new Error("no run.json");
    const frozen = JSON.stringify(runJson.value);
    expect(frozen).toContain(found.after);
    expect(frozen).not.toContain(found.before);
    // A later ordinary batch runs under the live hash.
    const plain = await certifyCall(env, "op_017", ["certify", CAP, "--json"]);
    expect(plain.code).toBe(EXIT.ok);
    const last = history(env).at(-1);
    if (last?.event !== "batch") throw new Error("expected a batch line");
    expect(last.kind).toBe("full");
    expect(last.under.handler_set).toBe(found.before);
  });

  test("the covering batch lets pack approve succeed", LONG, async () => {
    const env = await certifyReady("recovering");
    expect((await approve(env)).code).toBe(EXIT.refused);
    expect((await certifyCall(env, "op_017", REGRESSION)).code).toBe(EXIT.ok);
    expect((await approve(env)).code).toBe(EXIT.ok);
  });

  test("a failed gate exits 5, writes a failed batch line and no degraded line, and the key stays approved", LONG, async () => {
    const env = await certifyReady("kit");
    const r = await certifyCall(env, "op_017", REGRESSION);
    expect(r.code).toBe(EXIT.failed);
    expect(history(env).map((l) => l.event)).toEqual(["approved", "batch"]);
    expect(history(env)[1]).toMatchObject({ kind: "regression", gate: "failed" });
    expect(record(env).state).toBe("approved");
    // A failed regression blocks the pack.
    expect((await approve(env)).code).toBe(EXIT.refused);
  });

  test("one key by name: runs it; --kind regression with no --pack is a usage error; a missing key and no --all-affected is too", LONG, async () => {
    const env = await certifyReady("recovering");
    const one = await certifyCall(env, "op_017", ["certify", CAP, "--kind", "regression", "--pack", "app:kvfcu@2", "--json"]);
    expect(one.code).toBe(EXIT.ok);
    expect(history(env).at(-1)).toMatchObject({ event: "batch", kind: "regression" });
    const noPack = await certifyCall(env, "op_017", ["certify", CAP, "--kind", "regression"]);
    expect(noPack.code).toBe(EXIT.usage);
    expect(noPack.stderr).toContain("--pack");
    const noKey = await certifyCall(env, "op_017", ["certify", "--kind", "regression", "--pack", "app:kvfcu@2"]);
    expect(noKey.code).toBe(EXIT.usage);
  });

  test("--all-affected with no approved key touched runs nothing and exits 0", LONG, async () => {
    const env = await certifyReady("recovering", false);
    const r = await certifyCall(env, "op_017", REGRESSION);
    expect(r.code).toBe(EXIT.ok);
    expect((JSON.parse(r.stdout) as Batches).batches).toEqual([]);
    expect(r.harnesses.flatMap((h) => [...h.calls])).toEqual([]);
  });

  test("an operator role is needed", async () => {
    const env = await certifyReady("recovering");
    const r = await certifyCall(env, "op_031", REGRESSION);
    expect(r.code).toBe(EXIT.refused);
  });
});
