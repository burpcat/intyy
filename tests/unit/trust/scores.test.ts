// Proves score writes (design section 8 §5.2 record rebuilt then replaced, §5.6 writers and the
// per-tenant score lock, §4.2 an illegal line writes nothing; section 9 §9.8 rebuild, §6.3 key
// paths): appendHistory refuses an illegal line, a legal line appends and writes the record, a
// held score lock gives `busy`, a failed write gives `write_failed` and frees the lock, rebuildKey
// reports what changed and writes nothing for an empty key, listKeys skips non-key folders, and
// key paths and key text round-trip. Fake store, fake clock, in-memory locks. M10 task 1.
import { describe, expect, test } from "vitest";
import { hashJson } from "../../../src/core/model/canonical.js";
import { sealHash } from "../../../src/core/model/sealing.js";
import { HistoryLine } from "../../../src/core/model/score-history.js";
import { ScoreRecord, type ScoreKey } from "../../../src/core/model/score.js";
import { LockManager } from "../../../src/core/locks/manager.js";
import { keyPath, parseKeyPath, parseKeyText } from "../../../src/core/trust/keys.js";
import { rebuild } from "../../../src/core/trust/rebuild.js";
import {
  appendHistory,
  batchLine,
  hashesFor,
  listKeys,
  rebuildKey,
  type SealedArtifacts,
} from "../../../src/core/trust/scores.js";
import { SteppingClock } from "../../../src/fakes/clock.js";
import { MemoryLockSlots } from "../../../src/fakes/locks.js";
import { FakeScoreStore } from "../../../src/fakes/score-store.js";
import { approved, batch, degraded, h, KEY, retired } from "./kit.js";

const ARTIFACT = { identity: { app: "kvfcu", capability: "open_share_subaccount", version: "1.0.0" } };

/** An artifact store that holds one sealed artifact, or none. */
function artifacts(has: boolean): SealedArtifacts & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    getSealedArtifact: (id, version) => {
      asked.push(`${id}@${version}`);
      return Promise.resolve(
        has ? { ok: true as const, value: ARTIFACT } : { ok: false as const, failure: "not_found" as const },
      );
    },
  };
}

/** One world: a fake store, in-memory slots shared by two lock managers (this process and another). */
function world(has = true) {
  const slots = new MemoryLockSlots();
  const clock = new SteppingClock();
  const env = (pid: number) => ({ host: "host-a", pid, isAlive: () => true });
  const scores = new FakeScoreStore<HistoryLine, ScoreRecord>({ line: HistoryLine, record: ScoreRecord });
  const locks = new LockManager(slots, clock, env(1001));
  const other = new LockManager(slots, clock, env(1002));
  const art = artifacts(has);
  return { scores, locks, other, art, deps: { scores, locks, artifacts: art } };
}

const WHO = { owner: "batch_2026-01-15_aaaaaaaaaa", command: "certify", staff: "op_017" };
const PATH = keyPath(KEY);

/** True when the tenant's score lock is free right now. */
async function lockFree(w: ReturnType<typeof world>): Promise<boolean> {
  const got = await w.other.acquire("score", KEY.tenant, { owner: "x", command: "t", staff: null, waitMs: 0 });
  if (got.ok) await w.other.release(got.value);
  return got.ok;
}

describe("appendHistory", () => {
  test("a legal line appends, writes the rebuilt record, and returns it", async () => {
    const w = world();
    const r = await appendHistory(w.deps, KEY, approved(1), WHO);
    if (!r.ok) throw new Error(r.detail ?? r.failure);
    expect(r.value).toMatchObject({ state: "approved", state_by: "op_022" });
    expect(await w.scores.history(PATH)).toEqual({ ok: true, value: [approved(1)] });
    expect(await w.scores.getRecord(PATH)).toEqual({ ok: true, value: r.value });
    expect(await lockFree(w)).toBe(true);
  });

  test("the record equals a pure rebuild of the stored lines, with the seal hash of the artifact", async () => {
    const w = world();
    await appendHistory(w.deps, KEY, batch(1, "batch_a"), WHO);
    const r = await appendHistory(w.deps, KEY, approved(2), WHO);
    if (!r.ok) throw new Error("append failed");
    const lines = await w.scores.history(PATH);
    if (!lines.ok) throw new Error("history failed");
    const expected = rebuild(KEY, { artifact: sealHash(ARTIFACT), patch: null }, lines.value);
    expect(expected).toEqual({ ok: true, value: r.value });
    expect(r.value.hashes).toEqual({ artifact: sealHash(ARTIFACT), patch: null });
    expect(w.art.asked).toContain("kvfcu/open_share_subaccount@1.0.0");
  });

  test("an unsealed artifact gives a null artifact hash", async () => {
    const w = world(false);
    expect(await hashesFor(w.art, KEY)).toEqual({ artifact: null, patch: null });
  });

  test("an illegal line writes nothing: no line, no record", async () => {
    const w = world();
    const r = await appendHistory(w.deps, KEY, degraded(1), WHO);
    expect(r).toMatchObject({ ok: false, failure: "bad_history" });
    expect(await w.scores.history(PATH)).toEqual({ ok: true, value: [] });
    expect(await w.scores.getRecord(PATH)).toMatchObject({ ok: false, failure: "not_found" });
    expect(await w.scores.paths(KEY.tenant)).toEqual([]);
    expect(await lockFree(w)).toBe(true);
  });

  test("an illegal line after good ones leaves history and record as they were", async () => {
    const w = world();
    await appendHistory(w.deps, KEY, approved(1), WHO);
    await appendHistory(w.deps, KEY, retired(2), WHO);
    const record = await w.scores.getRecord(PATH);
    const r = await appendHistory(w.deps, KEY, approved(3), WHO);
    expect(r).toMatchObject({ ok: false, failure: "bad_history" });
    expect(r.ok ? "" : r.detail).toContain("line 3");
    const lines = await w.scores.history(PATH);
    expect(lines.ok ? lines.value : []).toHaveLength(2);
    expect(await w.scores.getRecord(PATH)).toEqual(record);
  });

  test("a staff-less approval is refused", async () => {
    const w = world();
    expect(await appendHistory(w.deps, KEY, approved(1, "certify"), WHO)).toMatchObject({
      ok: false,
      failure: "bad_history",
    });
    expect(await w.scores.paths(KEY.tenant)).toEqual([]);
  });

  test("a held score lock gives busy and writes nothing", async () => {
    const w = world();
    const held = await w.other.acquire("score", KEY.tenant, { ...WHO, owner: "batch_other", waitMs: 0 });
    expect(held.ok).toBe(true);
    const r = await appendHistory(w.deps, KEY, approved(1), WHO);
    expect(r).toMatchObject({ ok: false, failure: "busy" });
    expect(await w.scores.paths(KEY.tenant)).toEqual([]);
    if (held.ok) await w.other.release(held.value);
    expect(await appendHistory(w.deps, KEY, approved(1), WHO)).toMatchObject({ ok: true });
  });

  test("the lock is per tenant: another tenant's key is not blocked", async () => {
    const w = world();
    const held = await w.other.acquire("score", "lakeshore", { ...WHO, waitMs: 0 });
    expect(held.ok).toBe(true);
    expect(await appendHistory(w.deps, KEY, approved(1), WHO)).toMatchObject({ ok: true });
  });

  test("failWrites gives write_failed, writes nothing, and frees the lock", async () => {
    const w = world();
    w.scores.failWrites = true;
    expect(await appendHistory(w.deps, KEY, approved(1), WHO)).toMatchObject({
      ok: false,
      failure: "write_failed",
    });
    expect(await w.scores.history(PATH)).toEqual({ ok: true, value: [] });
    expect(await lockFree(w)).toBe(true);
    w.scores.failWrites = false;
    expect(await appendHistory(w.deps, KEY, approved(1), WHO)).toMatchObject({ ok: true });
  });
});

describe("rebuildKey", () => {
  test("an empty key stays a synthetic draft: changed [], written false, no files", async () => {
    const w = world();
    const r = await rebuildKey(w.deps, KEY, WHO);
    if (!r.ok) throw new Error("rebuild failed");
    expect(r.value).toMatchObject({ changed: [], written: false, before: null });
    expect(r.value.after.state).toBe("draft");
    expect(await w.scores.paths(KEY.tenant)).toEqual([]);
    expect(await lockFree(w)).toBe(true);
  });

  test("a key with history and no record: every field changed, record written", async () => {
    const w = world();
    await w.scores.append(PATH, approved(1));
    const r = await rebuildKey(w.deps, KEY, WHO);
    if (!r.ok) throw new Error("rebuild failed");
    expect(r.value.written).toBe(true);
    expect(r.value.before).toBeNull();
    expect(r.value.changed).toEqual(Object.keys(r.value.after));
    expect(await w.scores.getRecord(PATH)).toEqual({ ok: true, value: r.value.after });
  });

  test("a current record is unchanged; a tampered one is repaired and the field named", async () => {
    const w = world();
    await appendHistory(w.deps, KEY, approved(1), WHO);
    const clean = await rebuildKey(w.deps, KEY, WHO);
    expect(clean.ok ? clean.value.changed : null).toEqual([]);
    expect(clean.ok ? clean.value.written : null).toBe(true);

    const rec = await w.scores.getRecord(PATH);
    if (!rec.ok) throw new Error("no record");
    await w.scores.putRecord(PATH, { ...rec.value, alerts: ["alert_x"] });
    const fixed = await rebuildKey(w.deps, KEY, WHO);
    if (!fixed.ok) throw new Error("rebuild failed");
    expect(fixed.value.changed).toEqual(["alerts"]);
    expect(await w.scores.getRecord(PATH)).toEqual({ ok: true, value: rec.value });
  });

  test("a bad history is bad_history and leaves the record alone", async () => {
    const w = world();
    await w.scores.append(PATH, approved(1));
    await w.scores.append(PATH, retired(2));
    await w.scores.append(PATH, approved(3));
    const r = await rebuildKey(w.deps, KEY, WHO);
    expect(r).toMatchObject({ ok: false, failure: "bad_history" });
    expect(r.ok ? "" : r.detail).toContain("line 3");
    expect(await w.scores.getRecord(PATH)).toMatchObject({ ok: false, failure: "not_found" });
  });

  test("a held score lock gives busy", async () => {
    const w = world();
    await w.scores.append(PATH, approved(1));
    const held = await w.other.acquire("score", KEY.tenant, { ...WHO, waitMs: 0 });
    expect(held.ok).toBe(true);
    expect(await rebuildKey(w.deps, KEY, WHO)).toMatchObject({ ok: false, failure: "busy" });
  });

  test("failWrites gives write_failed and frees the lock", async () => {
    const w = world();
    await w.scores.append(PATH, approved(1));
    w.scores.failWrites = true;
    expect(await rebuildKey(w.deps, KEY, WHO)).toMatchObject({ ok: false, failure: "write_failed" });
    expect(await lockFree(w)).toBe(true);
  });
});

describe("listKeys", () => {
  test("lists a tenant's keys and skips folders that are not keys", async () => {
    const w = world();
    const patched: ScoreKey = { ...KEY, patch_revision: 3 };
    await w.scores.append(PATH, approved(1));
    await w.scores.append(keyPath(patched), approved(1));
    await w.scores.append("keystone/kvfcu/junk", approved(1));
    await w.scores.append("keystone/kvfcu/open_share_subaccount@1.0.0/9.2/px", approved(1));
    await w.scores.append(keyPath({ ...KEY, tenant: "lakeshore" }), approved(1));
    const found = await listKeys(w.scores, "keystone");
    expect(found.keys).toEqual([KEY, patched]);
    expect(found.skipped.sort()).toEqual([
      "keystone/kvfcu/junk",
      "keystone/kvfcu/open_share_subaccount@1.0.0/9.2/px",
    ]);
  });

  test("a tenant with no files lists nothing", async () => {
    expect(await listKeys(world().scores, "keystone")).toEqual({ keys: [], skipped: [] });
  });
});

describe("key paths and key text", () => {
  test("keyPath lays out tenant, capability, app version, and patch", () => {
    expect(keyPath(KEY)).toBe("keystone/kvfcu/open_share_subaccount@1.0.0/9.2/base");
    expect(keyPath({ ...KEY, patch_revision: 3 })).toBe("keystone/kvfcu/open_share_subaccount@1.0.0/9.2/p3");
  });

  test.each([null, 1, 3, 12])("parseKeyPath inverts keyPath for patch %s", (patch) => {
    const key: ScoreKey = { ...KEY, patch_revision: patch };
    expect(parseKeyPath(keyPath(key))).toEqual(key);
  });

  test.each([
    "keystone/kvfcu/open_share_subaccount@1.0.0/9.2",
    "keystone/kvfcu/open_share_subaccount@1.0.0/9.2/base/extra",
    "keystone/kvfcu/open_share_subaccount@1.0.0/9.2/p0",
    "keystone/kvfcu/open_share_subaccount@1.0.0/9.2/pX",
    "keystone/kvfcu/open_share_subaccount@1/9.2/base",
    "keystone/Kvfcu/open_share_subaccount@1.0.0/9.2/base",
  ])("parseKeyPath refuses %s", (path) => {
    expect(parseKeyPath(path)).toBeNull();
  });

  test("parseKeyText reads a key with and without a patch", () => {
    expect(parseKeyText("kvfcu/open_share_subaccount@1.0.0", "keystone", "9.2")).toEqual({
      ok: true,
      value: KEY,
    });
    expect(parseKeyText("kvfcu/open_share_subaccount@1.0.0+p3", "keystone", "9.2")).toEqual({
      ok: true,
      value: { ...KEY, patch_revision: 3 },
    });
  });

  test.each(["kvfcu/open_share_subaccount", "kvfcu/open_share_subaccount@1", "kvfcu/open_share_subaccount@1.0.0+p0", "open_share_subaccount@1.0.0", ""])(
    "parseKeyText refuses %j",
    (text) => {
      expect(parseKeyText(text, "keystone", "9.2")).toMatchObject({ ok: false, failure: "bad_key" });
    },
  );
});

describe("batchLine", () => {
  test("builds a batch line with the report's hash and the gate result", () => {
    const report = { gate: { passed: false } };
    const line = batchLine({
      at: new Date("2026-01-15T09:00:00.000Z"),
      by: "certify",
      reason: "r",
      batch: "batch_a",
      kind: "full",
      gatePassed: false,
      report,
      under: { engine: "0.4.0", handler_set: h("handlers"), jev: null, session: null, check: null },
    });
    expect(HistoryLine.safeParse(line).success).toBe(true);
    expect(line).toMatchObject({
      event: "batch",
      at: "2026-01-15T09:00:00.000Z",
      gate: "failed",
      report_hash: hashJson(report),
      scores: null,
    });
  });
});
