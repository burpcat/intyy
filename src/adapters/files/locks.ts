// Lock slots on files under `state/var/locks/`, and this process's host facts.
// Follows design section 9 §6.3 (lock paths) and §12.1 (exclusive create).
import { randomUUID } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { LockEnv, LockSlots } from "../../core/locks/manager.js";
import { LockFile } from "../../core/model/lock.js";
import { assertSafeName } from "../../core/model/safe-path.js";
import type { LockInfo, LockKind } from "../../ports/locks.js";
import { hasCode, prettyJson, readJson } from "./fs-util.js";

/** The folder for each lock kind (section 9 §6.3). */
const FOLDER: Record<LockKind, string> = { run: "runs", instance: "instances", score: "scores" };

/** Lock records as files: `<dir>/runs/<run_id>.lock` and so on. */
export class FileLockSlots implements LockSlots {
  readonly #dir: string;

  /** Slots in `dir`: `<root>/state/var/locks`. */
  constructor(dir: string) {
    this.#dir = dir;
  }

  /**
   * Exclusive create with full content: write a temp file, then hard-link it to the lock name.
   * Why a link: it fails if the name exists, and a reader never sees half a file.
   */
  async create(kind: LockKind, key: string, info: LockInfo): Promise<boolean> {
    const folder = join(this.#dir, FOLDER[kind]);
    await mkdir(folder, { recursive: true });
    const tmp = join(folder, `.tmp-${randomUUID()}`);
    await writeFile(tmp, prettyJson(info), { flag: "wx" });
    try {
      await link(tmp, this.#path(kind, key));
      return true;
    } catch (e) {
      if (hasCode(e, "EEXIST")) return false;
      throw e;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** Reads a lock file. */
  async read(kind: LockKind, key: string): Promise<LockInfo | "unreadable" | null> {
    const read = await readJson(this.#path(kind, key));
    if (read.kind === "missing") return null;
    if (read.kind === "bad") return "unreadable";
    const parsed = LockFile.safeParse(read.value);
    return parsed.success ? parsed.data : "unreadable";
  }

  /** Removes a lock file. */
  async remove(kind: LockKind, key: string): Promise<void> {
    await rm(this.#path(kind, key), { force: true });
  }

  #path(kind: LockKind, key: string): string {
    assertSafeName(key);
    return join(this.#dir, FOLDER[kind], `${key}.lock`);
  }
}

/** This process: its host name, its ID, and a liveness probe for other process IDs. */
export function systemLockEnv(): LockEnv {
  return {
    host: hostname(),
    pid: process.pid,
    isAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        // Why: EPERM means the process exists but belongs to another user. It is alive.
        return hasCode(e, "EPERM");
      }
    },
  };
}
