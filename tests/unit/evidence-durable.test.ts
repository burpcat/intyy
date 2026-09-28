// Proves durable appends reach the disk and a failed write returns write_failed.
// Design section 9 §5.8 (evidence store extras) and section 3 §6.6 (write-ahead rule).
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { FileEvidenceStore } from "../../src/adapters/files/other-stores.js";
import { FakeEvidenceStore } from "../../src/fakes/stores.js";
import type { EvidenceStore, RunFolder } from "../../src/ports/stores.js";
import { masked } from "../contract/test-kinds.js";

const RUN = "run_2026-01-15_7kq2m9x4tb";
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

/** A file evidence store in a fresh temporary root, with one run folder. */
async function fileRun(): Promise<{ root: string; store: EvidenceStore; run: RunFolder }> {
  const root = await mkdtemp(join(tmpdir(), "intyy-evidence-"));
  roots.push(root);
  const store = new FileEvidenceStore({ root: join(root, "evidence"), tmpDir: join(root, "tmp") });
  const run = await store.createRun("keystone", RUN);
  if (!run.ok) throw new Error("createRun failed");
  return { root, store, run: run.value };
}

/** The prototype of Node's FileHandle, so a test can watch `sync`. */
async function fileHandleProto(dir: string): Promise<{ sync: () => Promise<void> }> {
  const fh = await open(join(dir, "probe"), "w");
  await fh.close();
  return Object.getPrototypeOf(fh) as { sync: () => Promise<void> };
}

describe("durable append", () => {
  test("durable: true flushes the line to disk; a normal line does not", async () => {
    const { root, run } = await fileRun();
    const sync = vi.spyOn(await fileHandleProto(root), "sync");
    try {
      await run.appendEvent(masked({ seq: 1, event: "action" }));
      expect(sync).not.toHaveBeenCalled();
      expect(
        await run.appendEvent(masked({ seq: 2, event: "commit_intent" }), { durable: true }),
      ).toEqual({
        ok: true,
        value: undefined,
      });
      expect(sync).toHaveBeenCalledTimes(1);
    } finally {
      sync.mockRestore();
    }
    const text = await readFile(
      join(root, "evidence", "keystone", "runs", RUN, "events.jsonl"),
      "utf8",
    );
    expect(text).toBe('{"seq":1,"event":"action"}\n{"seq":2,"event":"commit_intent"}\n');
  });

  test("a failed write returns write_failed and never throws", async () => {
    const { root, run } = await fileRun();
    // Why a folder: opening a folder to append fails on every system, even as root.
    await mkdir(join(root, "evidence", "keystone", "runs", RUN, "events.jsonl"));
    const result = await run.appendEvent(masked({ seq: 1, event: "commit_intent" }), {
      durable: true,
    });
    expect(result).toMatchObject({ ok: false, failure: "write_failed" });
  });

  test("the fake twin can fail writes the same way", async () => {
    const store = new FakeEvidenceStore();
    const run = await store.createRun("keystone", RUN);
    if (!run.ok) throw new Error("createRun failed");
    store.failWrites = true;
    expect(await run.value.appendEvent(masked({ seq: 1 }), { durable: true })).toMatchObject({
      ok: false,
      failure: "write_failed",
    });
  });
});
