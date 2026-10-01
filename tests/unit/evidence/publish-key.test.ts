// Proves publishing a key's trust snapshot (design section 9 §6.6 evidence publish, updates file
// §12): a key target copies `history.jsonl` and `record.json` to `trust/scores/<key path>/`, plus
// the plan and report of every batch the history names; the manifest lists the key as an item of
// kind `key`; `verifyEvidence` finds it clean, and finds a missing snapshot file; a history that
// names a batch the source does not hold is `link_missing`; a key with no score files, or of
// another tenant, is `not_found`. The batch is one real certify batch on the fakes
// (tests/unit/evidence/kit.ts). M10 task 6.
import { describe, expect, test } from "vitest";
import { PublishManifest } from "../../../src/core/model/publish.js";
import type { HistoryLine } from "../../../src/core/model/score-history.js";
import type { ScoreKey } from "../../../src/core/model/score.js";
import { publishEvidence, verifyEvidence } from "../../../src/core/evidence/publish.js";
import { keyPath } from "../../../src/core/trust/keys.js";
import { rebuild } from "../../../src/core/trust/rebuild.js";
import { FakeFileTree } from "../../../src/fakes/file-tree.js";
import { approved, batch, HASHES, KEY as BASE_KEY } from "../trust/kit.js";
import { certifyFixture, TENANT, type Fixture } from "./kit.js";

const KEY: ScoreKey = { ...BASE_KEY, capability: "kvfcu/open_sub@1.0.0", tenant: TENANT, app_version: "8.4" };
const PATH = keyPath(KEY);

/** A trust tree holding the key's two files: a history that names `batchId`, and the record it gives. */
function trustTree(batchId: string, key: ScoreKey = KEY): FakeFileTree {
  const lines: HistoryLine[] = [batch(1, batchId), approved(2, "op_022", batchId)];
  const rec = rebuild(key, HASHES, lines);
  if (!rec.ok) throw new Error("test setup: rebuild failed");
  const tree = new FakeFileTree();
  tree.seed(`${keyPath(key)}/history.jsonl`, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  tree.seed(`${keyPath(key)}/record.json`, `${JSON.stringify(rec.value, null, 2)}\n`);
  return tree;
}

const publish = (f: Fixture, trust: FakeFileTree | undefined, id = PATH) =>
  publishEvidence(
    { tenant: TENANT, targets: [{ kind: "key", id }], by: "op_017", markers: [] },
    { source: f.source, library: f.library, dest: f.dest, ...(trust === undefined ? {} : { trust }), clock: f.clock },
  );

describe("publishing a key's trust snapshot", () => {
  test("copies the history, the record, and the plan and report of each batch the history names", async () => {
    const f = await certifyFixture();
    const got = await publish(f, trustTree(f.batchId));
    expect(got.ok).toBe(true);
    const paths = f.dest.paths();
    expect(paths).toEqual(
      expect.arrayContaining([
        `trust/scores/${PATH}/history.jsonl`,
        `trust/scores/${PATH}/record.json`,
        `${TENANT}/batches/${f.batchId}/plan.json`,
        `${TENANT}/batches/${f.batchId}/report.json`,
      ]),
    );
    if (got.ok) expect(got.value.batches).toEqual([f.batchId]);
  });

  test("the manifest lists the key as an item of kind key, and verify finds the evidence clean", async () => {
    const f = await certifyFixture();
    expect((await publish(f, trustTree(f.batchId))).ok).toBe(true);
    const raw = await f.dest.read("manifest.json");
    if (!raw.ok) throw new Error("no manifest");
    const manifest = PublishManifest.parse(JSON.parse(new TextDecoder().decode(raw.value)));
    expect(manifest.items).toEqual(expect.arrayContaining([{ kind: "key", id: PATH, tenant: TENANT }]));
    const verified = await verifyEvidence({ markers: [] }, { dest: f.dest });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.value.problems).toEqual([]);
  });

  test("verify finds a snapshot file that went missing", async () => {
    const f = await certifyFixture();
    await publish(f, trustTree(f.batchId));
    const copy = new FakeFileTree();
    for (const p of f.dest.paths()) {
      if (p === `trust/scores/${PATH}/record.json`) continue;
      const got = await f.dest.read(p);
      if (got.ok) copy.seed(p, new TextDecoder().decode(got.value));
    }
    const verified = await verifyEvidence({ markers: [] }, { dest: copy });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.value.problems.some((p) => p.includes("record.json"))).toBe(true);
  });

  test("a history that names a batch the source does not hold is link_missing, and nothing is written", async () => {
    const f = await certifyFixture();
    const got = await publish(f, trustTree("batch_2026-01-01_nothere0001"));
    expect(got).toMatchObject({ ok: false, failure: "link_missing" });
    expect(f.dest.paths()).toEqual([]);
  });

  test("a key with no score files is not_found", async () => {
    const f = await certifyFixture();
    expect(await publish(f, new FakeFileTree())).toMatchObject({ ok: false, failure: "not_found" });
    expect(await publish(f, undefined)).toMatchObject({ ok: false, failure: "not_found" });
  });

  test("a key of another tenant is not_found", async () => {
    const f = await certifyFixture();
    const other: ScoreKey = { ...KEY, tenant: "lakeshore" };
    expect(await publish(f, trustTree(f.batchId, other), keyPath(other))).toMatchObject({ ok: false, failure: "not_found" });
  });
});
