// Proves `intyy trust autonomy <key> [grant|revoke]` (design section 9 §9.5, section 8 §14.2): the read
// shows the state and the evidence against the rule (any role); `grant` needs an approver, the quoted
// record hash (a changed record exits 6), a `ready` record, and a reason on standard input, and writes
// a `granted` line; a record that is not ready, or was granted under another check key, is refused
// (exit 6); `revoke` needs an operator or an approver, a reason, and something to revoke, zeroes the
// evidence, and raises no alert (a person knows); both argument orders work. Temporary data roots
// only. M11 task 6.
import { afterAll, describe, expect, test } from "vitest";
import { EXIT } from "../../../src/cli/exit-codes.js";
import type { HistoryLine } from "../../../src/core/model/score-history.js";
import type { AutonomyCounts, AutonomyScope, Autonomy, ScoreKey } from "../../../src/core/model/score.js";
import type { AutonomyLine } from "../../../src/core/trust/autonomy.js";
import { keyPath } from "../../../src/core/trust/keys.js";
import { appendHistory } from "../../../src/core/trust/scores.js";
import { KEY as BASE_KEY } from "../trust/kit.js";
import { cleanRoots } from "./helpers.js";
import { realWiringOf, replayCall, replayRoot, type ReplayEnv } from "./replay-harness.js";

afterAll(cleanRoots);

/** `open_sub_checked` links `kvfcu/check_sub@1`, both sealed 1.0.0 in `replayRoot`; the tenant's app version is 8.4. */
const KEY: ScoreKey = { ...BASE_KEY, capability: "kvfcu/open_sub_checked@1.0.0", app_version: "8.4" };
const TEXT = "kvfcu/open_sub_checked@1.0.0";
const SCOPE: AutonomyScope = { check: "kvfcu/check_sub@1.0.0", check_patch: null, jev: "jev@fake" };
const HALF: AutonomyCounts = { correct: 10, found: 5, not_found: 5, wrong: 0, unclear: 0 };
const WHO = { owner: "test", command: "test", staff: null };

const at = (minute: number): string => `2026-01-15T07:${String(minute).padStart(2, "0")}:00.000Z`;
const earned = (minute: number, id: string, counts: AutonomyCounts = HALF, scope: AutonomyScope = SCOPE): AutonomyLine => ({
  event: "autonomy", at: at(minute), by: "certify", reason: `batch ${id}`, action: "earned", evidence: [id], scope, counts,
});

const trust = (env: ReplayEnv, staff: string, argv: string[], stdin = "") =>
  replayCall(env, ["trust", ...argv], { env: { INTYY_STAFF: staff }, stdin });

async function envWith(lines: AutonomyLine[]): Promise<ReplayEnv> {
  const env = await replayRoot();
  const w = realWiringOf(env);
  const deps = { scores: w.scores, locks: w.locks, artifacts: w.candidates };
  for (const l of lines) {
    const r = await appendHistory(deps, KEY, l, WHO);
    if (!r.ok) throw new Error(`test setup: ${r.detail ?? r.failure}`);
  }
  return env;
}

const EARNING = (): Promise<ReplayEnv> => envWith([earned(1, "batch_a")]);
const READY = (): Promise<ReplayEnv> => envWith([earned(1, "batch_a"), earned(2, "batch_b")]);

type Read = { key: string; state: string; autonomy: Autonomy | null; record: string };
async function read(env: ReplayEnv): Promise<Read> {
  const r = await trust(env, "op_017", ["autonomy", TEXT, "--json"]);
  expect(r.code).toBe(EXIT.ok);
  return JSON.parse(r.stdout) as Read;
}

const history = async (env: ReplayEnv): Promise<HistoryLine[]> => {
  const r = await realWiringOf(env).scores.history(keyPath(KEY));
  if (!r.ok) throw new Error("no history");
  return r.value;
};
const autonomyLines = async (env: ReplayEnv): Promise<AutonomyLine[]> =>
  (await history(env)).filter((l): l is AutonomyLine => l.event === "autonomy");

const grant = async (env: ReplayEnv, staff = "op_031", stdin = "The evidence is complete.", hash?: string) =>
  trust(env, staff, ["autonomy", TEXT, "grant", "--expect-record", hash ?? (await read(env)).record], stdin);

describe("trust autonomy: read", () => {
  test("no evidence: none; with evidence: the state and the counts against the rule, for any role", async () => {
    const none = await trust(await replayRoot(), "op_017", ["autonomy", TEXT]);
    expect(none.code).toBe(EXIT.ok);
    expect(none.stdout).toContain("none");
    const env = await EARNING();
    const r = await trust(env, "op_031", ["autonomy", TEXT]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("earning");
    expect(r.stdout).toContain("10 correct");
    expect(r.stdout).toContain("need 20 correct");
    expect(await read(env)).toMatchObject({ state: "earning", autonomy: { evidence: { correct: 10, found: 5, not_found: 5 } } });
  });

  test("a ready record says ready", async () => {
    expect(await read(await READY())).toMatchObject({ state: "ready" });
  });
});

describe("trust autonomy grant", () => {
  test("an approver grants a ready record: a granted line by them, the record is granted, and the reason is kept", async () => {
    const env = await READY();
    const r = await grant(env);
    expect(r.code).toBe(EXIT.ok);
    const lines = await autonomyLines(env);
    expect(lines.at(-1)).toMatchObject({ action: "granted", by: "op_031", reason: "The evidence is complete." });
    expect(await read(env)).toMatchObject({ state: "granted", autonomy: { granted: { by: "op_031", reason: "The evidence is complete." }, evidence: { correct: 20 } } });
  });

  test("a non-approver is refused, and nothing is written", async () => {
    const env = await READY();
    const before = (await history(env)).length;
    const r = await grant(env, "op_017");
    expect(r.code).toBe(EXIT.refused);
    expect((await history(env)).length).toBe(before);
    expect((await read(env)).state).toBe("ready");
  });

  test("a wrong --expect-record is refused (exit 6) and nothing is written", async () => {
    const env = await READY();
    const before = (await history(env)).length;
    const r = await grant(env, "op_031", "Evidence is complete.", `sha256:${"0".repeat(64)}`);
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toContain("record_changed");
    expect((await history(env)).length).toBe(before);
  });

  test("a missing --expect-record is a usage error", async () => {
    const env = await READY();
    const r = await trust(env, "op_031", ["autonomy", TEXT, "grant"], "Evidence is complete.");
    expect(r.code).toBe(EXIT.usage);
  });

  test("an empty reason on standard input is a usage error", async () => {
    const env = await READY();
    const r = await grant(env, "op_031", "  \n");
    expect(r.code).toBe(EXIT.usage);
    expect((await read(env)).state).toBe("ready");
  });

  test("not ready: exit 6, and nothing is written", async () => {
    const env = await EARNING();
    const refused = await grant(env);
    expect(refused.code).toBe(EXIT.refused);
    expect(refused.stderr).toContain("not ready");
    expect((await autonomyLines(env)).map((l) => l.action)).toEqual(["earned"]);
    // No autonomy record at all is not ready either.
    const empty = await replayRoot();
    expect((await grant(empty)).code).toBe(EXIT.refused);
  });

  test("both argument orders work", async () => {
    const a = await READY();
    const b = await READY();
    const first = await trust(a, "op_031", ["autonomy", "grant", TEXT, "--expect-record", (await read(a)).record], "Evidence is complete.");
    const second = await grant(b);
    expect([first.code, second.code]).toEqual([EXIT.ok, EXIT.ok]);
    expect((await read(a)).state).toBe("granted");
    expect((await read(b)).state).toBe("granted");
  });

  test("granting twice is refused: it is no longer ready", async () => {
    const env = await READY();
    expect((await grant(env)).code).toBe(EXIT.ok);
    expect((await grant(env, "op_031")).code).toBe(EXIT.refused);
  });
});

describe("trust autonomy: a changed scope", () => {
  test("a grant under another check key reads as revoked, with no write, and cannot be granted again", async () => {
    const old: AutonomyScope = { ...SCOPE, check: "kvfcu/old_check@1.0.0" };
    const env = await envWith([earned(1, "batch_a", HALF, old), earned(2, "batch_b", HALF, old)]);
    const w = realWiringOf(env);
    const deps = { scores: w.scores, locks: w.locks, artifacts: w.candidates };
    const g = await appendHistory(deps, KEY, { event: "autonomy", at: at(3), by: "op_031", reason: "Granted then.", action: "granted", evidence: [] }, WHO);
    expect(g.ok).toBe(true);
    const before = (await history(env)).length;
    const r = await read(env);
    expect(r.state).toBe("revoked");
    expect(r.autonomy?.state).toBe("granted"); // the stored record is untouched: nothing is written on a read
    expect((await history(env)).length).toBe(before);
    expect((await grant(env)).code).toBe(EXIT.refused);
  });
});

describe("trust autonomy revoke", () => {
  test("an operator revokes: a revoked line, zero evidence, no alert", async () => {
    const env = await READY();
    await grant(env);
    const r = await trust(env, "op_017", ["autonomy", TEXT, "revoke"], "Jev changed its answers.");
    expect(r.code).toBe(EXIT.ok);
    expect((await autonomyLines(env)).at(-1)).toMatchObject({ action: "revoked", by: "op_017", reason: "Jev changed its answers." });
    expect(await read(env)).toMatchObject({
      state: "revoked",
      autonomy: { evidence: { correct: 0, found: 0, not_found: 0, wrong: 0, unclear: 0, batches: [] }, granted: null, revoked: { by: "op_017" } },
    });
    const alerts = await realWiringOf(env).alerts.list();
    expect(alerts.ok && alerts.value).toEqual([]);
  });

  test("an approver may revoke, and so may either argument order; a ready record can be revoked too", async () => {
    const env = await READY();
    const r = await trust(env, "op_031", ["autonomy", "revoke", TEXT], "Not wanted.");
    expect(r.code).toBe(EXIT.ok);
    expect((await read(env)).state).toBe("revoked");
  });

  test("after a revoke the key earns from zero: one batch is earning again, never ready", async () => {
    const env = await READY();
    await trust(env, "op_017", ["autonomy", TEXT, "revoke"], "Reset.");
    const w = realWiringOf(env);
    const deps = { scores: w.scores, locks: w.locks, artifacts: w.candidates };
    await appendHistory(deps, KEY, earned(5, "batch_c"), WHO);
    expect(await read(env)).toMatchObject({ state: "earning", autonomy: { evidence: { correct: 10, batches: ["batch_c"] } } });
  });

  test("an empty reason is a usage error; no autonomy, or one already revoked, is refused", async () => {
    const env = await READY();
    expect((await trust(env, "op_017", ["autonomy", TEXT, "revoke"], "")).code).toBe(EXIT.usage);
    expect((await read(env)).state).toBe("ready");
    expect((await trust(await replayRoot(), "op_017", ["autonomy", TEXT, "revoke"], "Reason.")).code).toBe(EXIT.refused);
    await trust(env, "op_017", ["autonomy", TEXT, "revoke"], "Reason.");
    expect((await trust(env, "op_017", ["autonomy", TEXT, "revoke"], "Again.")).code).toBe(EXIT.refused);
  });

  test("a bad action word is a usage error", async () => {
    const env = await READY();
    expect((await trust(env, "op_017", ["autonomy", TEXT, "explode"], "Reason.")).code).toBe(EXIT.usage);
  });
});
