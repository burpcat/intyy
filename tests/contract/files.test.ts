// Runs every store contract suite against the file adapters, in a temporary data root.
// Design section 9 §5.9 (file adapters in a temporary folder) and §16 (store sealing).
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { FileDocumentStore } from "../../src/adapters/files/document-store.js";
import {
  FileCandidateStore,
  FileEvidenceStore,
  FileLogStore,
} from "../../src/adapters/files/other-stores.js";
import type { IndexLine } from "../../src/core/model/store-index.js";
import { ManualClock } from "../../src/fakes/clock.js";
import { documentStoreContract } from "./document-store.suite.js";
import {
  candidateStoreContract,
  evidenceStoreContract,
  logStoreContract,
} from "./other-stores.suite.js";
import type { DocumentStore } from "../../src/ports/stores.js";
import {
  CandidateFiles,
  Decision,
  doc,
  LogLine,
  LogRecord,
  testKind,
  type TestDoc,
} from "./test-kinds.js";

const roots: string[] = [];

/** A fresh temporary data root with `library/` and `state/var/tmp`. */
async function tempRoot(): Promise<{ root: string; tmpDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "intyy-stores-"));
  roots.push(root);
  return { root, tmpDir: join(root, "state", "var", "tmp") };
}

afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

/** Reads a JSON file, changes it, and writes it back: a hand edit. */
async function editJson(path: string, change: (d: Record<string, unknown>) => void): Promise<void> {
  const d = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  change(d);
  await writeFile(path, JSON.stringify(d));
}

documentStoreContract("files", async () => {
  const { root, tmpDir } = await tempRoot();
  const dir = join(root, "library", "test");
  const clock = new ManualClock();
  return {
    store: new FileDocumentStore(testKind, { dir, tmpDir }, clock),
    clock,
    tamper: (id, rev, change) => editJson(join(dir, id, `${rev}.json`), change),
    corruptCandidate: async (id, content) => {
      const cand = await new FileDocumentStore(testKind, { dir, tmpDir }, clock).getCandidate(id);
      if (!cand.ok) throw new Error("no candidate to corrupt");
      await writeFile(join(dir, id, `${cand.value.rev}.candidate.json`), JSON.stringify(content));
    },
  };
});

candidateStoreContract("files", async () => {
  const { root, tmpDir } = await tempRoot();
  const artifactsDir = join(root, "library", "artifacts");
  const store = new FileCandidateStore(
    { files: CandidateFiles, decision: Decision },
    { dir: join(root, "library", "candidates"), artifactsDir, tmpDir },
    new ManualClock(),
  );
  return {
    store,
    readSealed: async (artifactId, version) => {
      const base = join(artifactsDir, artifactId, version);
      let artifact: unknown;
      try {
        artifact = JSON.parse(await readFile(join(base, "artifact.json"), "utf8")) as unknown;
      } catch {
        return null;
      }
      const crops: Record<string, Uint8Array> = {};
      try {
        for (const name of await readdir(join(base, "crops"))) {
          crops[name.replace(/\.png$/, "")] = new Uint8Array(
            await readFile(join(base, "crops", name)),
          );
        }
      } catch {
        // no crops folder
      }
      const text = await readFile(join(artifactsDir, "index.jsonl"), "utf8").catch(() => "");
      const index: IndexLine[] =
        text.trim() === ""
          ? []
          : text
              .trim()
              .split("\n")
              .map((l) => JSON.parse(l) as IndexLine);
      return { artifact, crops, index };
    },
  };
});

logStoreContract("files", async () => {
  const { root, tmpDir } = await tempRoot();
  return new FileLogStore(
    { line: LogLine, record: LogRecord },
    { dir: join(root, "state", "trust"), tmpDir },
  );
});

evidenceStoreContract("files", async () => {
  const { root, tmpDir } = await tempRoot();
  return new FileEvidenceStore({ root: join(root, "state", "evidence"), tmpDir });
});

describe("file document store layout", () => {
  test("seal renames the candidate and writes one index line; writes leave no temp file; a broken index is invalid", async () => {
    const { root, tmpDir } = await tempRoot();
    const dir = join(root, "library", "policy");
    const store: DocumentStore<TestDoc> = new FileDocumentStore(
      testKind,
      { dir, tmpDir },
      new ManualClock("2026-09-26T08:00:00.000Z"),
    );
    await store.putCandidate("global", doc(1), "op_017");
    await expect(readFile(join(dir, "global", "1.candidate.json"), "utf8")).resolves.toContain(
      '"revision": 1',
    );

    const sealed = await store.seal("global", "op_017");
    if (!sealed.ok) throw new Error("seal failed");
    await expect(readFile(join(dir, "global", "1.candidate.json"))).rejects.toThrow();
    const index = (await readFile(join(dir, "index.jsonl"), "utf8")).trim().split("\n");
    expect(index.map((l) => JSON.parse(l) as unknown)).toEqual([
      {
        event: "sealed",
        kind: "test",
        id: "global",
        rev: "1",
        path: "global/1.json",
        hash: sealed.value.hash,
        by: "op_017",
        at: "2026-09-26T08:00:00.000Z",
      },
    ]);

    // atomic writes leave no temp files behind
    await store.approve("global", "1", "op_031");
    expect(await readdir(tmpDir)).toEqual([]);

    // a broken index line fails the read as invalid
    await writeFile(join(dir, "index.jsonl"), '{"event":"sealed"}\n');
    expect(await store.get("global", "1")).toMatchObject({ ok: false, failure: "invalid" });
  });
});
