// Runs the lock contract against memory slots and file slots in a temporary folder.
// Design section 9 §5.9 and §12. Also checks the real liveness probe.
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { FileLockSlots, systemLockEnv } from "../../src/adapters/files/locks.js";
import { MemoryLockSlots } from "../../src/fakes/locks.js";
import { locksContract } from "./locks.suite.js";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

/** A fresh lock folder. */
async function lockDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "intyy-locks-"));
  roots.push(root);
  return join(root, "state", "var", "locks");
}

locksContract("memory", () => Promise.resolve(new MemoryLockSlots()));

locksContract("files", async () => new FileLockSlots(await lockDir()));

describe("file lock slots", () => {
  test("locks sit at state/var/locks/<kind folder>/<key>.lock and leave no temp files", async () => {
    const dir = await lockDir();
    const slots = new FileLockSlots(dir);
    const info = {
      schema: "intyy.lock/1.0" as const,
      owner: "run_2026-01-15_7kq2m9x4tb",
      pid: 1,
      host: "h",
      command: "replay",
      staff: null,
      started_at: "2026-01-15T09:00:00.000Z",
    };
    expect(await slots.create("run", info.owner, info)).toBe(true);
    expect(await slots.create("run", info.owner, info)).toBe(false);
    expect(await slots.create("instance", "http_127.0.0.1_8080", info)).toBe(true);
    expect(await slots.create("score", "keystone", info)).toBe(true);
    expect(await readdir(join(dir, "runs"))).toEqual(["run_2026-01-15_7kq2m9x4tb.lock"]);
    expect(await readdir(join(dir, "instances"))).toEqual(["http_127.0.0.1_8080.lock"]);
    expect(await readdir(join(dir, "scores"))).toEqual(["keystone.lock"]);
    expect(await slots.read("run", info.owner)).toEqual(info);
  });

  test("a lock file that does not parse reads as unreadable", async () => {
    const dir = await lockDir();
    const slots = new FileLockSlots(dir);
    await slots.create("score", "keystone", {
      schema: "intyy.lock/1.0",
      owner: "x",
      pid: 1,
      host: "h",
      command: "c",
      staff: null,
      started_at: "2026-01-15T09:00:00.000Z",
    });
    await writeFile(join(dir, "scores", "keystone.lock"), "{");
    expect(await slots.read("score", "keystone")).toBe("unreadable");
  });

  test("the system liveness probe sees this process alive and a free ID dead", () => {
    const env = systemLockEnv();
    expect(env.isAlive(process.pid)).toBe(true);
    // Why 2^22 + 1: above the default Linux and macOS PID limits, so no process has it.
    expect(env.isAlive(4_194_305)).toBe(false);
  });
});
