// Proves alert writes (design section 8 §13.1 the reader runs after every score write and alerts
// carry ID, tenant, keys, pattern, evidence runs, suggested fix, and state; §5.3 the record lists its
// alerts; §5.6 a failed score write writes an alert and never changes a result; section 9 §9.7 `alert
// act` and `alert dismiss`): `scanDrift` writes one valid open alert per finding and raises the same
// finding once; a dismissed or acted alert stays quiet until new runs arrive, then a new alert lists
// the new runs; the record lists the open alert IDs and drops closed ones; `closeAlert` acts and
// dismisses, refuses a closed alert (`not_open`) and an unknown ID; `raiseLiveWriteFailed` writes its
// alert even while the score store fails; a failed alert write is `write_failed`; the after-write hook
// runs after a good score write, never after a failed one, and a throwing hook never changes the
// write. Fake stores, fake clock, in-memory locks. M11 task 3.
import { describe, expect, test } from "vitest";
import { Alert } from "../../../src/core/model/alert.js";
import type { LiveLine } from "../../../src/core/model/live-line.js";
import type { ScoreKey } from "../../../src/core/model/score.js";
import { closeAlert, isNewFinding, raiseLiveWriteFailed, scanDrift, type DriftDeps } from "../../../src/core/trust/alerts.js";
import type { Finding } from "../../../src/core/trust/drift.js";
import { keyPath, keyText } from "../../../src/core/trust/keys.js";
import { appendHistory, rebuildKey, recordLive } from "../../../src/core/trust/scores.js";
import { FakeAlertStore } from "../../../src/fakes/alert-store.js";
import { SeededIds } from "../../../src/fakes/ids.js";
import { approved, batch, KEY } from "./kit.js";
import { at, live, runId, WHO, world } from "./live-kit.js";

/** A world with an alert store and seeded alert IDs on top of the live-kit fakes. */
function driftWorld() {
  const w = world();
  const alerts = new FakeAlertStore<Alert>(Alert);
  const ids = new SeededIds(w.clock, 11);
  const deps: DriftDeps = { ...w.deps, alerts, clock: w.clock, ids };
  return { ...w, alerts, ids, deps };
}

const PATH = keyPath(KEY);
const low = (n: number): LiveLine => live(n, "clean", { margins: { open_member: 0.1 } });

/** Seeds an approved key and the given live lines straight into the stores (no drift run). */
async function seeded(w: ReturnType<typeof driftWorld>, lines: LiveLine[], key: ScoreKey = KEY): Promise<void> {
  for (const l of [batch(1, "batch_a"), approved(2)]) await w.scores.append(keyPath(key), l);
  for (const l of lines) await w.scores.appendLive(keyPath(key), l);
}

const listAlerts = async (w: ReturnType<typeof driftWorld>): Promise<Alert[]> => {
  const r = await w.alerts.list();
  return r.ok ? r.value : [];
};

describe("scanDrift", () => {
  test("scanDrift writes one valid alert per finding, raises it once, stays quiet after a close, and reports a failed write", async () => {
    // writes one valid open alert for a finding, with everything section 8 §13.1 lists
    {
      const w = driftWorld();
      await seeded(w, [low(1), low(2)]);
      const r = await scanDrift(w.deps, ["keystone"]);
      if (!r.ok) throw new Error(r.detail ?? r.failure);
      expect(r.value).toHaveLength(1);
      const a = r.value[0] as Alert;
      expect(Alert.safeParse(a).success).toBe(true);
      expect(a).toMatchObject({
        schema: "intyy.alert/1.0",
        tenant: "keystone",
        keys: [keyText(KEY)],
        pattern: "margin_drop",
        evidence_runs: [runId(1), runId(2)],
        state: "open",
        closed: null,
      });
      expect(a.id).toMatch(/^alert_\d{4}-\d{2}-\d{2}_/);
      expect(a.suggested_fix.length).toBeGreaterThan(0);
      expect(await listAlerts(w)).toEqual([a]);
    }
    // a key with nothing wrong writes no alert
    {
      const w = driftWorld();
      await seeded(w, [live(1), live(2)]);
      expect(await scanDrift(w.deps, ["keystone"])).toEqual({ ok: true, value: [] });
      expect(await listAlerts(w)).toEqual([]);
    }
    // the same finding is raised once: a second scan writes nothing while the alert is open
    {
      const w = driftWorld();
      await seeded(w, [low(1)]);
      await scanDrift(w.deps, ["keystone"]);
      const again = await scanDrift(w.deps, ["keystone"]);
      expect(again).toEqual({ ok: true, value: [] });
      expect(await listAlerts(w)).toHaveLength(1);
    }
    // a dismissed finding stays quiet until new runs arrive, then a new alert lists the new run
    {
      const w = driftWorld();
      await seeded(w, [low(1)]);
      const first = await scanDrift(w.deps, ["keystone"]);
      const id = first.ok ? (first.value[0]?.id ?? "") : "";
      await closeAlert(w.deps, id, "dismissed", "op_017", "Known.");
      expect(await scanDrift(w.deps, ["keystone"])).toEqual({ ok: true, value: [] });

      await w.scores.appendLive(PATH, low(2));
      const next = await scanDrift(w.deps, ["keystone"]);
      expect(next.ok && next.value).toHaveLength(1);
      expect(next.ok && next.value[0]?.evidence_runs).toEqual([runId(1), runId(2)]);
      expect((await listAlerts(w)).map((a) => a.state).sort()).toEqual(["dismissed", "open"]);
    }
    // an acted finding is quiet the same way
    {
      const w = driftWorld();
      await seeded(w, [low(1)]);
      const first = await scanDrift(w.deps, ["keystone"]);
      await closeAlert(w.deps, first.ok ? (first.value[0]?.id ?? "") : "", "acted", "op_017", "Sealed a patch.");
      expect(await scanDrift(w.deps, ["keystone"])).toEqual({ ok: true, value: [] });
    }
    // commit_uncertain raises one alert per run
    {
      const w = driftWorld();
      await seeded(w, [live(1, "recipe_failure", { code: "commit_uncertain", flags: ["commit_uncertain"] }), live(2, "recipe_failure", { code: "commit_uncertain", flags: ["commit_uncertain"] })]);
      const r = await scanDrift(w.deps, ["keystone"]);
      expect(r.ok && r.value.map((a) => [a.pattern, a.evidence_runs])).toEqual([["commit_uncertain", [runId(1)]], ["commit_uncertain", [runId(2)]]]);
    }
    // it reads every tenant it is given: one tenant's trouble is compared with the other's
    {
      const w = driftWorld();
      const other: ScoreKey = { ...KEY, tenant: "lakeshore" };
      const bad = (n: number): LiveLine => live(n, "recipe_failure", { step: "click_search", code: "target_not_found" });
      await seeded(w, [bad(1), bad(2)]);
      await seeded(w, [live(11), live(12), live(13)], other);
      const r = await scanDrift(w.deps, ["keystone", "lakeshore"]);
      expect(r.ok && r.value.map((a) => [a.pattern, a.tenant])).toEqual([["one_tenant", "keystone"]]);
      // With only this tenant read there is nothing to compare.
      const alone = driftWorld();
      await seeded(alone, [bad(1), bad(2)]);
      expect(await scanDrift(alone.deps, ["keystone"])).toEqual({ ok: true, value: [] });
    }
    // a failed alert write is write_failed and leaves no alert
    {
      const w = driftWorld();
      await seeded(w, [low(1)]);
      w.alerts.failWrites = true;
      expect(await scanDrift(w.deps, ["keystone"])).toMatchObject({ ok: false, failure: "write_failed" });
      w.alerts.failWrites = false;
      expect(await listAlerts(w)).toEqual([]);
    }
  });
});

describe("isNewFinding", () => {
  const finding: Finding = { pattern: "margin_drop", tenant: "keystone", keys: ["k"], runs: [runId(1)], at: at(1), detail: "d", fix: "f", fingerprint: "fp" };
  const alert = (state: Alert["state"], runs: string[]): Alert => ({
    schema: "intyy.alert/1.0",
    id: "alert_2026-01-15_00000000a1",
    tenant: "keystone",
    at: at(1),
    keys: ["k"],
    pattern: "margin_drop",
    detail: "d",
    fingerprint: "fp",
    evidence_runs: runs,
    suggested_fix: "f",
    state,
    closed: state === "open" ? null : { by: "op_017", at: at(2), note: "n" },
  });

  test("isNewFinding is new unless an open alert or a closed alert listed every run", () => {
    // no alert: new
    expect(isNewFinding([], finding)).toBe(true);
    // an open alert with the fingerprint: not new, even with new runs
    expect(isNewFinding([alert("open", [])], finding)).toBe(false);
    // a closed alert that listed all the runs: not new
    expect(isNewFinding([alert("dismissed", [runId(1)])], finding)).toBe(false);
    // a closed alert that missed a run: new
    expect(isNewFinding([alert("acted", [runId(9)])], finding)).toBe(true);
    // another tenant's alert with the same fingerprint does not count
    expect(isNewFinding([{ ...alert("open", [runId(1)]), tenant: "lakeshore" }], finding)).toBe(true);
  });
});

describe("the record lists open alerts (section 8 §5.3)", () => {
  test("the record lists open alerts, keeps them across score writes, and keeps them per key", async () => {
    // a raised alert shows on the record of its key, and a closed one is dropped
    {
      const w = driftWorld();
      await seeded(w, [low(1)]);
      const r = await scanDrift(w.deps, ["keystone"]);
      const id = r.ok ? (r.value[0]?.id ?? "") : "";
      const rec = await w.scores.getRecord(PATH);
      expect(rec.ok && rec.value.alerts).toEqual([id]);

      await closeAlert(w.deps, id, "dismissed", "op_017", "Known.");
      const after = await w.scores.getRecord(PATH);
      expect(after.ok && after.value.alerts).toEqual([]);
    }
    // a later score write keeps the open alerts on the record
    {
      const w = driftWorld();
      await seeded(w, [low(1)]);
      const r = await scanDrift(w.deps, ["keystone"]);
      const id = r.ok ? (r.value[0]?.id ?? "") : "";
      const written = await recordLive(w.deps, KEY, live(5), WHO, new Date(at(50)));
      expect(written.ok && written.value.record.alerts).toEqual([id]);
    }
    // an alert for one key is not on another key's record
    {
      const w = driftWorld();
      const other: ScoreKey = { ...KEY, capability: "kvfcu/other@1.0.0" };
      await seeded(w, [low(1)]);
      await seeded(w, [live(1)], other);
      await rebuildKey(w.deps, other, WHO);
      await scanDrift(w.deps, ["keystone"]);
      await rebuildKey(w.deps, other, WHO);
      const rec = await w.scores.getRecord(keyPath(other));
      expect(rec.ok ? rec.value.alerts : ["no record"]).toEqual([]);
      const mine = await w.scores.getRecord(PATH);
      expect(mine.ok && mine.value.alerts).toHaveLength(1);
    }
  });
});

describe("closeAlert (section 9 §9.7)", () => {
  async function open(w: ReturnType<typeof driftWorld>): Promise<string> {
    await seeded(w, [low(1)]);
    const r = await scanDrift(w.deps, ["keystone"]);
    return r.ok ? (r.value[0]?.id ?? "") : "";
  }

  test("closeAlert acts, dismisses, refuses a closed or unknown alert, and keeps an alert open on a failed write", async () => {
    // act marks it acted, with who, when, and what was done
    {
      const w = driftWorld();
      const id = await open(w);
      const r = await closeAlert(w.deps, id, "acted", "op_017", "Sealed pack revision 6.");
      expect(r.ok && r.value).toMatchObject({ id, state: "acted", closed: { by: "op_017", note: "Sealed pack revision 6." } });
      expect(Number.isNaN(Date.parse(r.ok ? (r.value.closed?.at ?? "") : ""))).toBe(false);
      const stored = await w.alerts.get(id);
      expect(stored.ok && stored.value.state).toBe("acted");
    }
    // dismiss marks it dismissed, with the reason
    {
      const w = driftWorld();
      const id = await open(w);
      const r = await closeAlert(w.deps, id, "dismissed", "op_017", "Bank maintenance.");
      expect(r.ok && r.value).toMatchObject({ state: "dismissed", closed: { note: "Bank maintenance." } });
    }
    // a closed alert cannot be closed again: not_open, and the first close stands
    {
      const w = driftWorld();
      const id = await open(w);
      await closeAlert(w.deps, id, "acted", "op_017", "First.");
      expect(await closeAlert(w.deps, id, "dismissed", "op_022", "Second.")).toMatchObject({ ok: false, failure: "not_open" });
      expect(await closeAlert(w.deps, id, "acted", "op_022", "Third.")).toMatchObject({ ok: false, failure: "not_open" });
      const stored = await w.alerts.get(id);
      expect(stored.ok && stored.value).toMatchObject({ state: "acted", closed: { by: "op_017", note: "First." } });
    }
    // an unknown ID is not_found
    {
      const w = driftWorld();
      expect(await closeAlert(w.deps, "alert_2026-01-15_00000000a1", "acted", "op_017", "x")).toMatchObject({ ok: false, failure: "not_found" });
    }
    // a failed write is write_failed and the alert stays open
    {
      const w = driftWorld();
      const id = await open(w);
      w.alerts.failWrites = true;
      expect(await closeAlert(w.deps, id, "acted", "op_017", "x")).toMatchObject({ ok: false, failure: "write_failed" });
      w.alerts.failWrites = false;
      const stored = await w.alerts.get(id);
      expect(stored.ok && stored.value.state).toBe("open");
    }
  });
});

describe("raiseLiveWriteFailed (section 8 §5.6)", () => {
  const failure = { tenant: "keystone", key: keyText(KEY), runId: runId(3), reason: "disk full" };

  test("raiseLiveWriteFailed writes one alert per run, even while the score store fails", async () => {
    // writes an alert naming the run and the repair, even while the score store fails
    {
      const w = driftWorld();
      w.scores.failWrites = true;
      const r = await raiseLiveWriteFailed(w.deps, failure);
      if (!r.ok) throw new Error(r.detail ?? r.failure);
      expect(r.value).toMatchObject({
        pattern: "live_write_failed",
        tenant: "keystone",
        keys: [keyText(KEY)],
        evidence_runs: [runId(3)],
        state: "open",
      });
      expect(r.value.suggested_fix).toContain(`intyy trust rebuild ${keyText(KEY)} --from-evidence`);
      expect(r.value.detail).toContain("disk full");
      expect(await listAlerts(w)).toEqual([r.value]);
    }
    // a failed alert write is write_failed
    {
      const w = driftWorld();
      w.alerts.failWrites = true;
      expect(await raiseLiveWriteFailed(w.deps, failure)).toMatchObject({ ok: false, failure: "write_failed" });
    }
    // two runs give two alerts with two fingerprints
    {
      const w = driftWorld();
      const a = await raiseLiveWriteFailed(w.deps, failure);
      const b = await raiseLiveWriteFailed(w.deps, { ...failure, runId: runId(4) });
      expect(a.ok && b.ok && a.value.fingerprint !== b.value.fingerprint).toBe(true);
    }
  });
});

describe("the after-write hook (section 8 §13.1, §5.6)", () => {
  test("the after-write hook runs after good writes only, never changes a write, and runs after the lock is released", async () => {
    // runs after a good history write and a good live write, with the key
    {
      const w = world();
      const heard: string[] = [];
      const deps = { ...w.deps, afterWrite: (k: ScoreKey) => { heard.push(keyText(k)); return Promise.resolve(); } };
      await appendHistory(deps, KEY, batch(1, "batch_a"), WHO);
      await recordLive(deps, KEY, live(1), WHO, new Date(at(5)));
      expect(heard).toEqual([keyText(KEY), keyText(KEY)]);
    }
    // never runs after a failed write
    {
      const w = world();
      let calls = 0;
      const deps = { ...w.deps, afterWrite: () => { calls++; return Promise.resolve(); } };
      w.scores.failWrites = true;
      await recordLive(deps, KEY, live(1), WHO, new Date(at(5)));
      await appendHistory(deps, KEY, batch(1, "batch_a"), WHO);
      expect(calls).toBe(0);
    }
    // a hook that throws never changes the write
    {
      const w = world();
      const deps = { ...w.deps, afterWrite: () => Promise.reject(new Error("reader broke")) };
      const r = await recordLive(deps, KEY, live(1), WHO, new Date(at(5)));
      expect(r.ok).toBe(true);
      const lines = await w.scores.liveLines(PATH);
      expect(lines.ok && lines.value).toHaveLength(1);
    }
    // it runs after the lock is released, so the reader may take it
    {
      const w = world();
      let free = false;
      const deps = {
        ...w.deps,
        afterWrite: async () => {
          const got = await w.other.acquire("score", KEY.tenant, { ...WHO, waitMs: 0 });
          free = got.ok;
          if (got.ok) await w.other.release(got.value);
        },
      };
      await appendHistory(deps, KEY, batch(1, "batch_a"), WHO);
      expect(free).toBe(true);
    }
  });
});
