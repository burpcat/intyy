// Proves `intyy alert list | show | act | dismiss` and `intyy drift report [--since]` end to end
// (design section 9 §9.7; section 8 §13.1 the reader runs after every score write, §13.2 patterns,
// §5.3 the record lists alerts, §5.2 a missing record shows the live score, §5.6 a failed live write
// writes an alert): `list` shows open alerts of this tenant, newest first, and `--state` picks
// another; `show` prints the pattern, runs, and fix; `act` and `dismiss` need the operator role and
// read their text from standard input (a flag is refused), and a closed alert exits 6; `drift report`
// shows the findings with the alert that already covers each, `--since` filters by date, and it
// writes nothing; a score write through the CLI runs the reader; `trust show` of a key whose
// `record.json` is missing still shows its live data; a replay whose live write failed leaves a
// `live_write_failed` alert, and no alert file holds a member ID or an account number. Temporary data
// roots only. M11 task 3.
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { EXIT } from "../../../src/cli/exit-codes.js";
import type { Alert } from "../../../src/core/model/alert.js";
import type { LiveLine } from "../../../src/core/model/live-line.js";
import type { ScoreKey, ScoreRecord } from "../../../src/core/model/score.js";
import { keyPath } from "../../../src/core/trust/keys.js";
import { approved, batch, KEY as BASE_KEY } from "../trust/kit.js";
import { live, runId } from "../trust/live-kit.js";
import { cleanRoots } from "./helpers.js";
import { ACCOUNT_NUMBER, MEMBER_FOUND, realWiringOf, replayCall, replayRoot, runSupervisedToEnd, writeAuthorization, writeInputs, type ReplayEnv } from "./replay-harness.js";

afterAll(cleanRoots);

const LONG = { timeout: 120_000 };

const KEY: ScoreKey = { ...BASE_KEY, capability: "kvfcu/open_sub@1.0.0", app_version: "8.4" };
const SESSION_KEY: ScoreKey = { ...KEY, capability: "kvfcu/sign_in@1.0.0" };
const TEXT = "kvfcu/open_sub@1.0.0";
const FINGERPRINT = `margin_drop:${TEXT}:open_member`;

const id = (n: number): string => `alert_2026-01-15_${String(n).padStart(8, "0")}a1`;

/** A made-up alert. `over` replaces any field. */
function alertOf(n: number, over: Partial<Alert> = {}): Alert {
  return {
    schema: "intyy.alert/1.0",
    id: id(n),
    tenant: "keystone",
    at: `2026-01-15T10:0${String(n)}:00.000Z`,
    keys: [TEXT],
    pattern: "margin_drop",
    detail: `Target open_member: lowest live margin 0.10, below 0.30 (alert ${String(n)}).`,
    fingerprint: `fp_${String(n)}`,
    evidence_runs: [runId(n)],
    suggested_fix: "Review target open_member before it breaks.",
    state: "open",
    closed: null,
    ...over,
  };
}

const trust = (env: ReplayEnv, staff: string, argv: string[], stdin = "") =>
  replayCall(env, argv, { env: { INTYY_STAFF: staff }, stdin });

async function putAlerts(env: ReplayEnv, ...alerts: Alert[]): Promise<void> {
  for (const a of alerts) {
    const r = await realWiringOf(env).alerts.put(a.id, a);
    if (!r.ok) throw new Error("test setup: alert write failed");
  }
}

/** An approved key with `lines` as live lines, written straight to the store (no reader run). */
async function seedKey(env: ReplayEnv, lines: LiveLine[], key: ScoreKey = KEY): Promise<void> {
  const scores = realWiringOf(env).scores;
  for (const l of [batch(1, "batch_a"), approved(2)]) await scores.append(keyPath(key), l);
  for (const l of lines) await scores.appendLive(keyPath(key), l);
}

const low = (n: number): LiveLine => live(n, "clean", { margins: { open_member: 0.1 } });
const alertFiles = (env: ReplayEnv): string[] => {
  try {
    return readdirSync(join(env.root, "state", "trust", "alerts"));
  } catch {
    return [];
  }
};
const stored = async (env: ReplayEnv, n: number): Promise<Alert> => {
  const r = await realWiringOf(env).alerts.get(id(n));
  if (!r.ok) throw new Error("test setup: no alert");
  return r.value;
};

describe("alert list", () => {
  test("shows open alerts of this tenant, newest first; --state picks acted or dismissed; a bad state exits 1", async () => {
    const env = await replayRoot();
    await putAlerts(env, alertOf(1), alertOf(2), alertOf(3, { state: "dismissed", closed: { by: "op_017", at: "2026-01-15T11:00:00.000Z", note: "n" } }), alertOf(4, { tenant: "lakeshore" }));
    const r = await trust(env, "op_017", ["alert", "list"]);
    expect(r.code).toBe(EXIT.ok);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(id(2));
    expect(lines[1]).toContain(id(1));
    expect(r.stdout).toContain("margin_drop");
    expect(r.stdout).not.toContain(id(3));
    expect(r.stdout).not.toContain(id(4));

    const dismissed = await trust(env, "op_017", ["alert", "list", "--state", "dismissed"]);
    expect(dismissed.stdout).toContain(id(3));
    expect(dismissed.stdout).not.toContain(id(1));
    expect((await trust(env, "op_017", ["alert", "list", "--state", "acted"])).stdout).toContain("No acted alerts.");
    expect((await trust(env, "op_017", ["alert", "list", "--state", "bogus"])).code).toBe(EXIT.usage);
  });
  test("with no alerts it says so, and any staff member may read; --json is the list of alerts", async () => {
    const empty = await replayRoot();
    const r = await trust(empty, "op_031", ["alert", "list"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("No open alerts.");

    const env = await replayRoot();
    await putAlerts(env, alertOf(1));
    const body = JSON.parse((await trust(env, "op_017", ["alert", "list", "--json"])).stdout) as Alert[];
    expect(body).toEqual([alertOf(1)]);
  });
});

describe("alert show", () => {
  test("prints the pattern, keys, evidence runs, and suggested fix; an unknown ID, and another tenant's alert, exit 1", async () => {
    const env = await replayRoot();
    await putAlerts(env, alertOf(1), alertOf(4, { tenant: "lakeshore" }));
    const r = await trust(env, "op_017", ["alert", "show", id(1)]);
    expect(r.code).toBe(EXIT.ok);
    for (const text of ["margin_drop", TEXT, runId(1), "Review target open_member before it breaks.", "lowest live margin 0.10"]) expect(r.stdout).toContain(text);
    expect(JSON.parse((await trust(env, "op_017", ["alert", "show", id(1), "--json"])).stdout)).toEqual(alertOf(1));

    expect((await trust(env, "op_017", ["alert", "show", id(9)])).code).toBe(EXIT.usage);
    expect((await trust(env, "op_017", ["alert", "show", id(4)])).code).toBe(EXIT.usage);
  });
});

describe("alert act and dismiss", () => {
  test("act and dismiss refuse bad calls and leave the alert open; then each closes with text from standard input", async () => {
    const env = await replayRoot();
    await putAlerts(env, alertOf(1), alertOf(2), alertOf(3));

    // no text on standard input exits 1 and leaves the alert open
    expect((await trust(env, "op_017", ["alert", "act", id(1)])).code).toBe(EXIT.usage);
    expect((await trust(env, "op_017", ["alert", "dismiss", id(1)])).code).toBe(EXIT.usage);
    expect((await stored(env, 1)).state).toBe("open");

    // text on a flag is refused: there is no --with and no --reason
    expect((await trust(env, "op_017", ["alert", "act", id(1), "--with", "a note"])).code).toBe(EXIT.usage);
    expect((await trust(env, "op_017", ["alert", "dismiss", id(1), "--reason", "a note"])).code).toBe(EXIT.usage);
    expect((await stored(env, 1)).state).toBe("open");

    // a person without the operator role exits 6 and writes nothing
    for (const verb of ["act", "dismiss"]) {
      const denied = await trust(env, "op_031", ["alert", verb, id(1)], "Because.");
      expect(denied.code, verb).toBe(EXIT.refused);
      expect(denied.stderr, verb).toContain("operator");
    }
    expect((await stored(env, 1)).state).toBe("open");

    // an unknown alert exits 1
    expect((await trust(env, "op_017", ["alert", "act", id(9)], "x")).code).toBe(EXIT.usage);

    // act marks the alert acted, with the text from standard input
    const r = await trust(env, "op_017", ["alert", "act", id(1)], "Sealed pack revision 6.\n");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(EXIT.ok);
    expect(await stored(env, 1)).toMatchObject({ state: "acted", closed: { by: "op_017", note: "Sealed pack revision 6." } });

    // dismiss marks the alert dismissed, with the reason from standard input
    const dismissed = await trust(env, "op_022", ["alert", "dismiss", id(3)], "Bank maintenance window.");
    expect(dismissed.code).toBe(EXIT.ok);
    expect(await stored(env, 3)).toMatchObject({ state: "dismissed", closed: { by: "op_022", note: "Bank maintenance window." } });

    // a closed alert exits 6 and keeps its first close
    await trust(env, "op_017", ["alert", "act", id(2)], "First.");
    const closed = await trust(env, "op_017", ["alert", "dismiss", id(2)], "Second.");
    expect(closed.code).toBe(EXIT.refused);
    expect(await stored(env, 2)).toMatchObject({ state: "acted", closed: { note: "First." } });

    expect((await trust(env, "op_017", ["alert", "list"])).stdout).toContain("No open alerts.");
  });
});

describe("drift report", () => {
  test("shows each finding with its pattern, key, detail, and fix, and writes nothing", LONG, async () => {
    const env = await replayRoot();
    await seedKey(env, [low(1), low(2)]);
    const r = await trust(env, "op_031", ["drift", "report"]);
    expect(r.code).toBe(EXIT.ok);
    for (const text of ["margin_drop", TEXT, "open_member", "fix:"]) expect(r.stdout).toContain(text);
    expect(alertFiles(env)).toEqual([]);
    const json = JSON.parse((await trust(env, "op_031", ["drift", "report", "--json"])).stdout) as { pattern: string; keys: string[]; runs: string[]; alert: string | null }[];
    expect(json).toMatchObject([{ pattern: "margin_drop", keys: [TEXT], runs: [runId(1), runId(2)], alert: null }]);
  });
  test("with nothing wrong it says so, and it reports only this tenant's findings", LONG, async () => {
    const env = await replayRoot();
    // it reports only this tenant's findings
    await seedKey(env, [low(1)], { ...KEY, tenant: "lakeshore" });
    expect((await trust(env, "op_031", ["drift", "report"])).stdout, "other tenant").toContain("No drift found.");
    // with nothing wrong it says so
    await seedKey(env, [live(1), live(2)]);
    expect((await trust(env, "op_031", ["drift", "report"])).stdout, "clean key").toContain("No drift found.");
  });
  test("--since keeps findings on or after the date and rejects a non-date; a finding with an open alert shows the alert's ID", LONG, async () => {
    const env = await replayRoot();
    await seedKey(env, [low(1)]);
    expect((await trust(env, "op_031", ["drift", "report", "--since", "2026-01-15"])).stdout).toContain("margin_drop");
    expect((await trust(env, "op_031", ["drift", "report", "--since", "2026-01-16"])).stdout).toContain("No drift found.");
    // a --since that is not a date exits 1
    expect((await trust(env, "op_031", ["drift", "report", "--since", "yesterday"])).code).toBe(EXIT.usage);

    await putAlerts(env, alertOf(1, { fingerprint: FINGERPRINT }));
    const r = await trust(env, "op_031", ["drift", "report"]);
    expect(r.stdout).toContain(`alert: ${id(1)}`);
    const closed = alertOf(1, { fingerprint: FINGERPRINT, state: "dismissed", closed: { by: "op_017", at: "2026-01-15T11:00:00.000Z", note: "n" } });
    await putAlerts(env, closed);
    expect((await trust(env, "op_031", ["drift", "report"])).stdout).not.toContain("alert:");
  });
});

describe("the reader runs after a score write", () => {
  test("a history write through the CLI raises the alert for trouble already in the live lines", LONG, async () => {
    const env = await replayRoot();
    await seedKey(env, [low(1), live(2)]);
    expect(alertFiles(env)).toEqual([]);
    // `trust exclude` writes a history line, so the reader runs once it is done.
    expect((await trust(env, "op_022", ["trust", "exclude", TEXT, runId(2)], "Known outage.")).code).toBe(EXIT.ok);
    const list = JSON.parse((await trust(env, "op_017", ["alert", "list", "--json"])).stdout) as Alert[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ pattern: "margin_drop", keys: [TEXT], evidence_runs: [runId(1)], state: "open" });
    // The record lists the open alert (section 8 §5.3).
    const shown = JSON.parse((await trust(env, "op_017", ["trust", "show", TEXT, "--json"])).stdout) as { record: ScoreRecord };
    expect(shown.record.alerts).toEqual([list[0]?.id]);
    // A second write raises nothing new.
    await trust(env, "op_022", ["trust", "exclude", TEXT, runId(2)], "Again.");
    expect(alertFiles(env)).toHaveLength(1);
  });
});

describe("trust show with no record.json", () => {
  test("still shows the live score from the live lines", LONG, async () => {
    const env = await replayRoot();
    await realWiringOf(env).scores.appendLive(keyPath(KEY), live(1));
    await realWiringOf(env).scores.appendLive(keyPath(KEY), live(2, "recipe_failure"));
    const shown = JSON.parse((await trust(env, "op_017", ["trust", "show", TEXT, "--json"])).stdout) as { record: ScoreRecord };
    expect(shown.record.live?.current).toMatchObject({ counted: 2, clean: 1, recipe_failures: 1, score: 0.5 });
    expect(shown.record.state).toBe("draft");
  });
  test("a deleted record.json shows the same record as before", LONG, async () => {
    const env = await replayRoot();
    await seedKey(env, [live(1), live(2)]);
    await trust(env, "op_017", ["trust", "rebuild", TEXT]);
    const file = join(env.root, "state", "trust", "scores", keyPath(KEY), "record.json");
    const before = JSON.parse((await trust(env, "op_017", ["trust", "show", TEXT, "--json"])).stdout) as { hash: string };
    rmSync(file);
    const after = JSON.parse((await trust(env, "op_017", ["trust", "show", TEXT, "--json"])).stdout) as { hash: string; record: ScoreRecord };
    expect(after.record.live?.current.counted).toBe(2);
    expect(after.hash).toBe(before.hash);
  });
});

describe("a replay whose live write failed", () => {
  async function failedWriteRun() {
    const env = await replayRoot();
    // `live.jsonl` is a folder, so no line can be appended (the same trick as trust-live.test.ts).
    for (const key of [KEY, SESSION_KEY]) mkdirSync(join(env.root, "state", "trust", "scores", keyPath(key), "live.jsonl"), { recursive: true });
    const inputs = writeInputs(env, { member_id: MEMBER_FOUND });
    const auth = writeAuthorization(env, "kvfcu/open_sub@1");
    const got = await runSupervisedToEnd(env, ["replay", "kvfcu/open_sub@1", "--mode", "supervised", "--inputs", inputs, "--authorization", auth, "--json"]);
    return { env, got };
  }

  test("writes a live_write_failed alert per key, naming the run and the repair; the result stands; no alert file holds a member ID or an account number", LONG, async () => {
    const { env, got } = await failedWriteRun();
    expect(got.code).toBe(EXIT.ok);
    expect((JSON.parse(got.stdout) as { status: string }).status).toBe("success");
    const list = JSON.parse((await trust(env, "op_017", ["alert", "list", "--json"])).stdout) as Alert[];
    expect(list.map((a) => a.pattern)).toEqual(["live_write_failed", "live_write_failed"]);
    expect(list.map((a) => a.keys[0]).sort()).toEqual([SESSION_KEY.capability, KEY.capability].sort());
    for (const a of list) {
      expect(a.evidence_runs).toEqual([got.runId]);
      expect(a.suggested_fix).toContain(`intyy trust rebuild ${a.keys[0] ?? ""} --from-evidence`);
    }

    const files = alertFiles(env);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(env.root, "state", "trust", "alerts", f), "utf8");
      expect(text).not.toContain(MEMBER_FOUND);
      expect(text).not.toContain(ACCOUNT_NUMBER);
    }
  });
});
