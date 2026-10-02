// Proves the drift reader's pure rules (design section 8 §12.4 early warnings, §13.2 patterns, §13.3
// tying a drop to a change, §16.2 the pack revision example): the early warnings fire at their edges
// and not just short of them (`margin_drop` below 0.30 or below half the certify margin, `detector_drift`
// at 3 flags for one handler, `app_health` at 30% of a window of at least 5 runs, `timeout_pressure`
// at 5 runs past 80% of the timeout, one alert per run for `commit_uncertain` and `contradiction`);
// excluded runs and retired keys give none; "one tenant" and "one bank, many capabilities" fire and
// then miss by one condition each; a change point names pack `app:kvfcu` revision 5 when 3 of the 4
// keys that switched to it dropped and the key that stayed did not (the test gate row), and stays
// quiet when a key that did not switch also dropped, when fewer than half the switched keys dropped,
// or when the runs are too few; with no pack revisions it names the hash; the same test runs for the
// engine and the jev version. Pure: hand-built records from `rebuild`. M11 task 3.
import { describe, expect, test } from "vitest";
import type { LiveLine } from "../../../src/core/model/live-line.js";
import type { HistoryLine } from "../../../src/core/model/score-history.js";
import type { ScoreKey } from "../../../src/core/model/score.js";
import {
  allFindings,
  changePoints,
  earlyWarnings,
  oneTenantPattern,
  outagePattern,
  since,
  type KeyFacts,
} from "../../../src/core/trust/drift.js";
import { keyText } from "../../../src/core/trust/keys.js";
import { rebuild } from "../../../src/core/trust/rebuild.js";
import { approved, batch, h, HASHES, KEY, retired, SCORES } from "./kit.js";
import { at, live, runId } from "./live-kit.js";

const APPROVED: HistoryLine[] = [batch(1, "batch_a"), approved(2)];

/** The facts of one key, its record rebuilt from the two logs like a score write does. */
function facts(
  key: ScoreKey,
  live: LiveLine[],
  history: HistoryLine[] = APPROVED,
  timeouts: Record<string, number> = {},
): KeyFacts {
  const r = rebuild(key, HASHES, history, live);
  if (!r.ok) throw new Error("test setup: rebuild failed");
  return { key, record: r.value, history, live, timeouts };
}

const keyOf = (capability: string, tenant = "keystone", appVersion = "9.2"): ScoreKey => ({ ...KEY, capability, tenant, app_version: appVersion });
const only = (f: KeyFacts) => earlyWarnings(f);
const patterns = (f: KeyFacts) => earlyWarnings(f).map((x) => x.pattern);

/** Clean lines from run `from`, `count` of them, each with `over`. */
const run = (from: number, count: number, cls: LiveLine["class"] = "clean", over: Partial<LiveLine> = {}): LiveLine[] =>
  Array.from({ length: count }, (_, i) => live(from + i, cls, over));

describe("margin_drop (section 8 §12.4)", () => {
  test("margin_drop fires below 0.30 or half the certify margin, once per target, naming the target and runs", () => {
    // a live margin of 0.29 fires; 0.30 and 0.31 do not
    expect(patterns(facts(KEY, [live(1, "clean", { margins: { open_member: 0.29 } })]))).toEqual(["margin_drop"]);
    expect(patterns(facts(KEY, [live(1, "clean", { margins: { open_member: 0.3 } })]))).toEqual([]);
    expect(patterns(facts(KEY, [live(1, "clean", { margins: { open_member: 0.31 } })]))).toEqual([]);
    // it names the target and the runs whose margin was low
    {
      const f = only(facts(KEY, [live(1, "clean", { margins: { a: 0.9, open_member: 0.1 } }), live(2, "clean", { margins: { a: 0.9, open_member: 0.2 } }), live(3)]))[0];
      expect(f).toMatchObject({ pattern: "margin_drop", tenant: "keystone", keys: [keyText(KEY)], runs: [runId(1), runId(2)] });
      expect(f?.detail).toContain("open_member");
      expect(f?.fingerprint).toContain("open_member");
    }
    // a target below half its certify margin fires even above 0.30
    {
      const strong = [batch(1, "batch_a", { scores: { ...SCORES, margin: { lowest: 0.8, step: "open_member" } } }), approved(2)];
      expect(patterns(facts(KEY, [live(1, "clean", { margins: { open_member: 0.35 } })], strong))).toEqual(["margin_drop"]);
      expect(patterns(facts(KEY, [live(1, "clean", { margins: { open_member: 0.45 } })], strong))).toEqual([]);
    }
    // with a weak certify margin the 0.30 floor still applies
    expect(patterns(facts(KEY, [live(1, "clean", { margins: { open_member: 0.2 } })]))).toEqual(["margin_drop"]);
    // one finding per target
    {
      const f = facts(KEY, [live(1, "clean", { margins: { a: 0.1, b: 0.1 } })]);
      expect(earlyWarnings(f).map((x) => x.fingerprint).sort()).toHaveLength(2);
    }
  });
});

describe("detector_drift", () => {
  const miss = (n: number, handler: string): LiveLine => live(n, "clean", { flags: [`detector_missed:${handler}`] });

  test("detector_drift fires at 3 flags for one handler, counted per handler, and names the handler and runs", () => {
    // 3 detector_missed flags for one handler fire; 2 do not
    expect(patterns(facts(KEY, [miss(1, "notice"), miss(2, "notice"), miss(3, "notice")]))).toEqual(["detector_drift"]);
    expect(patterns(facts(KEY, [miss(1, "notice"), miss(2, "notice")]))).toEqual([]);
    // flags are counted per handler, not across handlers
    expect(patterns(facts(KEY, [miss(1, "a"), miss(2, "a"), miss(3, "b"), miss(4, "b")]))).toEqual([]);
    // the finding names the handler and the three runs
    {
      const f = only(facts(KEY, [miss(1, "notice"), miss(2, "notice"), miss(3, "notice"), live(4)]))[0];
      expect(f).toMatchObject({ pattern: "detector_drift", runs: [runId(1), runId(2), runId(3)] });
      expect(f?.detail).toContain("notice");
    }
  });
});

describe("app_health", () => {
  test("app_health fires at 30% of at least 5 runs, with the app failures as evidence", () => {
    // 3 app failures in 10 runs (30%) fire; 2 in 10 do not
    expect(patterns(facts(KEY, [...run(1, 7), ...run(8, 3, "app_failure", { code: "app_error" })]))).toEqual(["app_health"]);
    expect(patterns(facts(KEY, [...run(1, 8), ...run(9, 2, "app_failure", { code: "app_error" })]))).toEqual([]);
    // a window of 4 runs is too short, even at 50%
    expect(patterns(facts(KEY, [...run(1, 2), ...run(3, 2, "app_failure", { code: "app_error" })]))).toEqual([]);
    // the evidence is the app failures
    {
      const f = only(facts(KEY, [...run(1, 7), ...run(8, 3, "app_failure", { code: "app_error" })]))[0];
      expect(f?.runs).toEqual([runId(8), runId(9), runId(10)]);
    }
  });
});

describe("timeout_pressure", () => {
  const slow = (n: number, ms: number): LiveLine => live(n, "clean", { step_ms: { click_search: ms } });
  const timeouts = { click_search: 1000 };

  test("timeout_pressure fires at 5 runs past 80% of the timeout in force", () => {
    // 5 runs past 80% of the timeout fire; 4 do not
    expect(patterns(facts(KEY, [1, 2, 3, 4, 5].map((n) => slow(n, 850)), APPROVED, timeouts))).toEqual(["timeout_pressure"]);
    expect(patterns(facts(KEY, [1, 2, 3, 4].map((n) => slow(n, 850)), APPROVED, timeouts))).toEqual([]);
    // exactly 80% is not past it
    expect(patterns(facts(KEY, [1, 2, 3, 4, 5].map((n) => slow(n, 800)), APPROVED, timeouts))).toEqual([]);
    // a step with no timeout in force gives nothing
    expect(patterns(facts(KEY, [1, 2, 3, 4, 5].map((n) => slow(n, 9000))))).toEqual([]);
  });
});

describe("commit_uncertain and contradiction: one alert per run", () => {
  test("commit_uncertain and contradiction give one finding per run", () => {
    // two uncertain runs give two findings, each with one run
    {
      const f = earlyWarnings(facts(KEY, [live(1, "recipe_failure", { code: "commit_uncertain", flags: ["commit_uncertain"] }), live(2), live(3, "recipe_failure", { code: "commit_uncertain", flags: ["commit_uncertain"] })]));
      expect(f.map((x) => [x.pattern, x.runs])).toEqual([["commit_uncertain", [runId(1)]], ["commit_uncertain", [runId(3)]]]);
      expect(new Set(f.map((x) => x.fingerprint)).size).toBe(2);
    }
    // a contradiction flag gives one finding per run
    {
      const f = earlyWarnings(facts(KEY, [live(1, "clean", { flags: ["reconciliation_contradiction"] }), live(2, "clean", { flags: ["reconciliation_contradiction"] })]));
      expect(f.map((x) => [x.pattern, x.runs])).toEqual([["contradiction", [runId(1)]], ["contradiction", [runId(2)]]]);
    }
  });
});

describe("what the warnings leave out", () => {
  test("excluded runs and retired keys give no finding; a draft key does; a finding takes its newest evidence time", () => {
    // excluded runs give no finding
    {
      const history: HistoryLine[] = [...APPROVED, { event: "excluded", at: at(0), by: "op_022", reason: "Outage.", runs: [runId(1)] }];
      expect(earlyWarnings(facts(KEY, [live(1, "clean", { margins: { t: 0.1 }, flags: ["commit_uncertain"] })], history))).toEqual([]);
    }
    // a retired key gives no finding
    expect(earlyWarnings(facts(KEY, [live(1, "clean", { margins: { t: 0.1 } })], [...APPROVED, retired(3)]))).toEqual([]);
    // a draft key still gets warnings
    expect(patterns(facts(KEY, [live(1, "clean", { margins: { t: 0.1 } })], []))).toEqual(["margin_drop"]);
    // a finding's time is its newest evidence
    expect(only(facts(KEY, [live(1, "clean", { margins: { t: 0.1 } }), live(2, "clean", { margins: { t: 0.1 } })]))[0]?.at).toBe(at(2));
  });
});

describe("one tenant (section 8 §13.2)", () => {
  const CAP = "kvfcu/open_share_subaccount@1.0.0";
  const failing = (tenant: string, appVersion = "9.2", cap = CAP) =>
    facts(keyOf(cap, tenant, appVersion), run(1, 2, "recipe_failure", { step: "click_search", code: "target_not_found" }));
  const healthy = (tenant: string, appVersion = "9.2", cap = CAP) => facts(keyOf(cap, tenant, appVersion), run(1, 5));

  test("one_tenant fires on a lone failing tenant and misses by one condition each", () => {
    // two failures at one step and code at one tenant, with a healthy tenant on the same app version, fire
    {
      const found = oneTenantPattern([failing("keystone"), healthy("lakeshore")]);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ pattern: "one_tenant", tenant: "keystone", keys: [CAP], runs: [runId(1), runId(2)] });
      expect(found[0]?.detail).toContain("click_search");
      expect(found[0]?.detail).toContain("lakeshore");
    }
    // one failure is not enough
    {
      const one = facts(keyOf(CAP, "keystone"), [live(1, "recipe_failure", { step: "click_search", code: "target_not_found" })]);
      expect(oneTenantPattern([one, healthy("lakeshore")])).toEqual([]);
    }
    // with no other tenant to compare, it never fires
    expect(oneTenantPattern([failing("keystone")])).toEqual([]);
    // a tenant with no runs is no comparison
    expect(oneTenantPattern([failing("keystone"), facts(keyOf(CAP, "lakeshore"), [])])).toEqual([]);
    // when both tenants fail the same way it is not one tenant
    expect(oneTenantPattern([failing("keystone"), failing("lakeshore")])).toEqual([]);
    // a healthy tenant on another app version does not count
    expect(oneTenantPattern([failing("keystone"), healthy("lakeshore", "9.3")])).toEqual([]);
    // a healthy tenant on another capability major does not count
    expect(oneTenantPattern([failing("keystone"), healthy("lakeshore", "9.2", "kvfcu/open_share_subaccount@2.0.0")])).toEqual([]);
    // failures at different steps are not one group
    {
      const mixed = facts(keyOf(CAP, "keystone"), [
        live(1, "recipe_failure", { step: "a", code: "target_not_found" }),
        live(2, "recipe_failure", { step: "b", code: "target_not_found" }),
      ]);
      expect(oneTenantPattern([mixed, healthy("lakeshore")])).toEqual([]);
    }
  });
});

describe("one bank, many capabilities (outage)", () => {
  const CAPS = ["kvfcu/a@1.0.0", "kvfcu/b@1.0.0", "kvfcu/c@1.0.0"];
  const degradedAt = (minute: number, by = "live_score"): HistoryLine => ({ event: "degraded", at: at(minute), by, reason: "Window.", rule: "window", runs: [] });
  /** A key that degraded at `minute`, after app failures (and `recipe` recipe failures). */
  const key = (i: number, minute: number, o: { app?: number; recipe?: number; by?: string } = {}): KeyFacts => {
    const base = 100 + i * 20;
    const lines = [
      ...Array.from({ length: o.app ?? 4 }, (_, n) => live(base + n, "app_failure", { code: "app_error", at: at(minute - 20 + n) })),
      ...Array.from({ length: o.recipe ?? 1 }, (_, n) => live(base + 10 + n, "recipe_failure", { at: at(minute - 15 + n) })),
    ];
    return facts(keyOf(CAPS[i] ?? "kvfcu/z@1.0.0"), lines, [...APPROVED, degradedAt(minute, o.by)]);
  };
  const three = (minutes: number[], o: Parameters<typeof key>[2] = {}) => minutes.map((m, i) => key(i, m, o));

  test("outage fires for 3 keys degraded by live score within an hour and misses by one condition each", () => {
    // 3 keys degrade within an hour, mostly app failures: fire
    {
      const found = outagePattern(three([60, 70, 80]));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ pattern: "outage", tenant: "keystone", keys: CAPS });
      expect(found[0]?.runs.length).toBeGreaterThan(0);
    }
    // two keys are not enough
    expect(outagePattern(three([60, 70, 80]).slice(0, 2))).toEqual([]);
    // degrades spread over more than an hour do not fire
    expect(outagePattern(three([30, 60, 95]))).toEqual([]);
    // mostly recipe failures is not an outage
    expect(outagePattern(three([60, 70, 80], { app: 1, recipe: 4 }))).toEqual([]);
    // a human demotion or a certify degrade is not a live-score degrade
    expect(outagePattern(three([60, 70, 80], { by: "op_022" }))).toEqual([]);
    // keys of different tenants are not pooled
    {
      const keys = three([60, 70, 80]);
      const third = keys[2] as KeyFacts;
      const other = facts({ ...third.key, tenant: "lakeshore" }, [...third.live], [...third.history]);
      expect(outagePattern([keys[0] as KeyFacts, keys[1] as KeyFacts, other])).toEqual([]);
    }
  });
});

describe("change point (section 8 §13.3, §16.2; the test gate row)", () => {
  const OLD = h("handlers-old");
  const NEW = h("handlers-new");
  const caps = ["kvfcu/k1@1.0.0", "kvfcu/k2@1.0.0", "kvfcu/k3@1.0.0", "kvfcu/k4@1.0.0", "kvfcu/k5@1.0.0"];
  type Under = LiveLine["under"];
  const old: Under = { engine: "0.4.0", handler_set: OLD, jev: null, packs: { "app:kvfcu": 4 } };
  const next: Under = { engine: "0.4.0", handler_set: NEW, jev: null, packs: { "app:kvfcu": 5 } };
  /**
   * One key: 6 clean runs under `before` (minutes 1 to 6), then 6 under `after` (minutes 7 to 12), of which
   * `bad` fail at one step. Run IDs differ per key.
   */
  function key(i: number, after: Under | null, bad: number, before: Under = old): KeyFacts {
    const id = (m: number): number => i * 20 + m;
    const lines: LiveLine[] = [];
    for (let m = 1; m <= 6; m++) lines.push(live(id(m), "clean", { at: at(m), under: before }));
    for (let m = 7; m <= 12; m++) {
      const fails = m - 7 < bad;
      lines.push(live(id(m), fails ? "recipe_failure" : "clean", { at: at(m), under: after ?? before }));
    }
    return facts(keyOf(caps[i] ?? "kvfcu/z@1.0.0"), lines);
  }
  /** Four keys switched (the first `dropped` of them with failures) and key 5 stayed. */
  const world = (dropped: number, after: Under = next, stayedBad = 0, before: Under = old): KeyFacts[] => [
    ...[0, 1, 2, 3].map((i) => key(i, after, i < dropped ? 3 : 0, before)),
    key(4, null, stayedBad, before),
  ];

  test("changePoints names the switched change and stays quiet when the evidence is short", () => {
    // 3 of the 4 switched keys dropped and the key that stayed did not: one finding names pack app:kvfcu revision 5
    {
      const found = changePoints(world(3));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ pattern: "change_point", tenant: "keystone", keys: caps.slice(0, 3) });
      expect(found[0]?.detail).toContain("pack app:kvfcu revision 5");
      expect(found[0]?.detail).toContain("3 of 4");
      expect(found[0]?.runs.length).toBe(9);
      expect(found[0]?.at).toBe(at(7));
    }
    // it is one finding in allFindings too, and the same finding twice has one fingerprint
    {
      const a = allFindings(world(3)).filter((f) => f.pattern === "change_point");
      const b = changePoints(world(3));
      expect(a).toHaveLength(1);
      expect(a[0]?.fingerprint).toBe(b[0]?.fingerprint);
    }
    // a key that did not switch and also dropped: no alert
    expect(changePoints(world(3, next, 3))).toEqual([]);
    // fewer than half the switched keys dropped: no alert
    expect(changePoints(world(1))).toEqual([]);
    expect(changePoints(world(0))).toEqual([]);
    // exactly half the switched keys dropped fires
    expect(changePoints(world(2))).toHaveLength(1);
    // a drop of fewer than 3 runs after the change is no evidence
    {
      const short = (i: number) => {
        const f = key(i, next, 3);
        return facts(f.key, f.live.slice(0, 8));
      };
      expect(changePoints([short(0), short(1), short(2), short(3), key(4, null, 0)])).toEqual([]);
    }
    // with no pack revisions on the lines, the alert names the handler set hash
    {
      const bare = (u: Under): Under => ({ engine: u.engine, handler_set: u.handler_set, jev: u.jev });
      const found = changePoints(world(3, bare(next), 0, bare(old)));
      expect(found).toHaveLength(1);
      expect(found[0]?.detail).toContain(`handler set ${NEW.slice(0, 19)}`);
      expect(found[0]?.detail).not.toContain("pack ");
    }
    // the same test runs for the engine version
    {
      const found = changePoints(world(3, { ...old, engine: "0.5.0" }));
      expect(found).toHaveLength(1);
      expect(found[0]?.detail).toContain("engine 0.5.0");
    }
    // and for the jev version
    {
      const found = changePoints(world(3, { ...old, jev: "2.0.0" }));
      expect(found).toHaveLength(1);
      expect(found[0]?.detail).toContain("jev 2.0.0");
    }
    // a change that moved nothing gives nothing
    expect(changePoints([0, 1, 2, 3, 4].map((i) => key(i, null, 3)))).toEqual([]);
    // a retired key is left out
    {
      const keys = world(3);
      const dead = keys[0] as KeyFacts;
      const retiredFacts = facts(dead.key, dead.live as LiveLine[], [...APPROVED, retired(3)]);
      expect(changePoints([retiredFacts, ...keys.slice(1)])[0]?.keys).toEqual(caps.slice(1, 3));
    }
  });
});

describe("since", () => {
  test("keeps the findings whose newest evidence is on or after the date", () => {
    const early = earlyWarnings(facts(KEY, [live(1, "clean", { margins: { t: 0.1 } })]));
    const late = earlyWarnings(facts(keyOf("kvfcu/z@1.0.0"), [live(5, "clean", { margins: { t: 0.1 } })]));
    const both = [...early, ...late];
    expect(since(both, at(5)).map((f) => f.at)).toEqual([at(5)]);
    expect(since(both, "2026-01-15").length).toBe(2);
    expect(since(both, "2026-01-16")).toEqual([]);
  });
});
