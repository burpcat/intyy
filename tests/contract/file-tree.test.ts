// Contract for the file tree port, run against the fake and the file adapter in a temporary
// folder: list by prefix (sorted, with sizes), read and `not_found`, write that replaces, folders
// made as needed, and an unsafe path is a throw. The adapter also leaves no staging file behind.
// Design section 9 §6.6, §5.8, §5.9. M07 task 10.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { FsFileTree } from "../../src/adapters/files/file-tree.js";
import { FakeFileTree } from "../../src/fakes/file-tree.js";
import type { FileTree } from "../../src/ports/tree.js";

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The shared contract. `make` gives a fresh, empty tree. */
function fileTreeContract(label: string, make: () => Promise<FileTree>): void {
  describe(`FileTree contract: ${label}`, () => {
    test("a written file reads back, a missing one is not_found, and a second write replaces", async () => {
      const t = await make();
      expect(await t.write("a/b/c.txt", enc("hello"))).toEqual({ ok: true, value: undefined });
      const got = await t.read("a/b/c.txt");
      expect(got.ok && new TextDecoder().decode(got.value)).toBe("hello");
      expect(await t.read("a/b/none.txt")).toMatchObject({ ok: false, failure: "not_found" });

      await t.write("x.txt", enc("one"));
      await t.write("x.txt", enc("two"));
      const second = await t.read("x.txt");
      expect(second.ok && new TextDecoder().decode(second.value)).toBe("two");
    });

    test("list gives sorted paths with sizes, under a prefix only; a missing folder lists nothing", async () => {
      const t = await make();
      await t.write("run/b.txt", enc("bb"));
      await t.write("run/a/z.txt", enc("zzz"));
      await t.write("run2/c.txt", enc("c"));
      await t.write("top.txt", enc(""));
      expect(await t.list("run")).toEqual([
        { path: "run/a/z.txt", bytes: 3 },
        { path: "run/b.txt", bytes: 2 },
      ]);
      expect(await t.list("run/")).toEqual(await t.list("run"));
      expect((await t.list("")).map((f) => f.path)).toEqual(["run/a/z.txt", "run/b.txt", "run2/c.txt", "top.txt"]);
      expect(await t.list("nothing/here")).toEqual([]);
    });

    test("an unsafe path throws", async () => {
      const t = await make();
      // Why a wrapper: the fake throws at the call, the adapter rejects its promise. Both are "throws".
      const throws = async (call: () => Promise<unknown>): Promise<boolean> => {
        try {
          await call();
          return false;
        } catch {
          return true;
        }
      };
      for (const path of ["../escape.txt", "a/../../b", "/abs.txt", "a//b", ".hidden/x"]) {
        expect(await throws(() => t.read(path)), `read ${path}`).toBe(true);
        expect(await throws(() => t.write(path, enc("x"))), `write ${path}`).toBe(true);
      }
    });
  });
}

fileTreeContract("fake", () => Promise.resolve(new FakeFileTree()));

fileTreeContract("file adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "intyy-tree-"));
  roots.push(root);
  return new FsFileTree(join(root, "tree"), join(root, "tmp"));
});

describe("FsFileTree staging", () => {
  test("a write leaves nothing behind in the staging folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "intyy-tree-"));
    roots.push(root);
    const t = new FsFileTree(join(root, "tree"), join(root, "tmp"));
    await t.write("a.txt", enc("x"));
    const left = await readdir(join(root, "tmp")).catch(() => []);
    expect(left).toEqual([]);
  });
});
