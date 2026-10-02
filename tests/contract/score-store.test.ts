// Runs the score store contract against the fake and the file adapter (design section 8 §5.2
// three files per key, record replaced whole; section 9 §5.9 fakes and files agree, §6.3 state
// layout). The file adapter writes `record.json` through `state/var/tmp` and leaves no temp
// file. M10 task 1.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { FileScoreStore } from "../../src/adapters/files/score-store.js";
import { HistoryLine } from "../../src/core/model/score-history.js";
import { ScoreRecord } from "../../src/core/model/score.js";
import { keyPath } from "../../src/core/trust/keys.js";
import { rebuild } from "../../src/core/trust/rebuild.js";
import { FakeScoreStore } from "../../src/fakes/score-store.js";
import type { ScoreStore } from "../../src/ports/scores.js";
import { approved, batch, HASHES, KEY, retired } from "../unit/trust/kit.js";

type Store = ScoreStore<HistoryLine, ScoreRecord>;
const schemas = { line: HistoryLine, record: ScoreRecord };
const PATH = keyPath(KEY);
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

/** A fresh temporary data root, and a file store in `state/trust/scores`. */
async function fileStore(): Promise<{ store: Store; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "intyy-scores-"));
  roots.push(root);
  const dirs = { dir: join(root, "state", "trust", "scores"), tmpDir: join(root, "state", "var", "tmp") };
  return { store: new FileScoreStore(schemas, dirs), root };
}

/** The record the lines give. */
function recordOf(lines: HistoryLine[]): ScoreRecord {
  const r = rebuild(KEY, HASHES, lines);
  if (!r.ok) throw new Error("rebuild failed");
  return r.value;
}

/** Runs the score store contract on one implementation. */
function contract(label: string, make: () => Promise<Store>): void {
  describe(`ScoreStore contract: ${label}`, () => {
    test("history, record, paths, and unsafe paths", async () => {
      const store = await make();
      expect(await store.history(PATH)).toEqual({ ok: true, value: [] });
      expect(await store.append(PATH, batch(1, "batch_a"))).toEqual({ ok: true, value: undefined });
      await store.append(PATH, approved(2));
      expect(await store.history(PATH)).toEqual({ ok: true, value: [batch(1, "batch_a"), approved(2)] });

      // a record is replaced whole; a missing record is not_found
      expect(await store.getRecord(PATH)).toMatchObject({ ok: false, failure: "not_found" });
      const first = recordOf([approved(1)]);
      const second = recordOf([approved(1), retired(2)]);
      await store.putRecord(PATH, first);
      await store.putRecord(PATH, second);
      expect(await store.getRecord(PATH)).toEqual({ ok: true, value: second });

      // paths lists a tenant's key folders, sorted, whichever file made them
      const patched = keyPath({ ...KEY, patch_revision: 3 });
      await store.putRecord(patched, recordOf([approved(1)]));
      await store.append(PATH, approved(1));
      await store.append(keyPath({ ...KEY, tenant: "lakeshore" }), approved(1));
      expect(await store.paths("keystone")).toEqual([PATH, patched]);
      expect(await store.paths("nobody")).toEqual([]);

      // an unsafe path is refused, not written
      await expect(async () => store.append("../outside", approved(1))).rejects.toThrow();
      await expect(async () => store.putRecord("keystone/../../x", recordOf([]))).rejects.toThrow();
    });
  });
}

contract("fake", () => Promise.resolve(new FakeScoreStore(schemas)));
contract("files", async () => (await fileStore()).store);

describe("fake score store", () => {
  test("failWrites makes append and putRecord return write_failed and write nothing", async () => {
    const store = new FakeScoreStore(schemas);
    store.failWrites = true;
    expect(await store.append(PATH, approved(1))).toMatchObject({ ok: false, failure: "write_failed" });
    expect(await store.putRecord(PATH, recordOf([]))).toMatchObject({ ok: false, failure: "write_failed" });
    expect(await store.history(PATH)).toEqual({ ok: true, value: [] });
    expect(await store.paths("keystone")).toEqual([]);
  });
});

describe("file score store layout", () => {
  test("history.jsonl and record.json sit at state/trust/scores/<key path>; no temp file is left", async () => {
    const { store, root } = await fileStore();
    await store.append(PATH, approved(1));
    await store.append(PATH, approved(2));
    await store.putRecord(PATH, recordOf([approved(1)]));
    await store.putRecord(PATH, recordOf([approved(1), retired(2)]));
    const dir = join(root, "state", "trust", "scores", PATH);
    expect((await readdir(dir)).sort()).toEqual(["history.jsonl", "record.json"]);
    const text = await readFile(join(dir, "history.jsonl"), "utf8");
    expect(text.trim().split("\n").map((l) => JSON.parse(l) as unknown)).toEqual([approved(1), approved(2)]);
    expect(JSON.parse(await readFile(join(dir, "record.json"), "utf8"))).toMatchObject({ state: "retired" });
    expect(await readdir(join(root, "state", "var", "tmp"))).toEqual([]);
  });

  test("a folder holding no score file is not a key, and a corrupt history is invalid", async () => {
    const { store, root } = await fileStore();
    const dir = join(root, "state", "trust", "scores", PATH);
    await mkdir(join(root, "state", "trust", "scores", "keystone", "stray"), { recursive: true });
    await writeFile(join(root, "state", "trust", "scores", "keystone", "stray", "notes.txt"), "x");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "history.jsonl"), "{not json\n");
    expect(await store.paths("keystone")).toEqual([PATH]);
    expect(await store.history(PATH)).toMatchObject({ ok: false, failure: "invalid" });
  });

  test("a record that breaks the schema is invalid", async () => {
    const { store, root } = await fileStore();
    const dir = join(root, "state", "trust", "scores", PATH);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "record.json"), JSON.stringify({ schema: "intyy.score/1.0", state: "weird" }));
    expect(await store.getRecord(PATH)).toMatchObject({ ok: false, failure: "invalid" });
  });
});
