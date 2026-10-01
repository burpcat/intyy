// The mailbox: the operator port on plain files in the run folder, and the desk the operator CLI
// uses. Follows design section 9 §5.4 (operator port), §10.5 (mailbox records), and section 7
// §13.4 (the operator port in the build). Atomic writes: temp file first, then rename.
import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { ClaimFile, DecisionFile, DialogLine, ReleaseFile } from "../../core/model/mailbox.js";
import type { Masked } from "../../ports/masked.js";
import type {
  Handle,
  Intervention,
  InterventionDesk,
  OpenRequest,
  OperatorEvent,
  OperatorPort,
} from "../../ports/operator.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";

/** How often the engine looks for an answer (section 7 §13.4). */
export const POLL_MS = 500;

/** Where the mailbox files live: `<evidence>/<tenant>/runs/<run_id>/mailbox/`. */
export type MailboxDirs = { evidenceRoot: string; tmpDir: string };

/** True when `e` is a Node error with this code. */
const isCode = (e: unknown, code: string): boolean =>
  e instanceof Error && "code" in e && e.code === code;

/** Writes a file atomically: temp file in `tmpDir`, then rename. */
async function writeAtomic(tmpDir: string, path: string, text: string): Promise<void> {
  await mkdir(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `mailbox-${randomUUID()}.json`);
  await writeFile(tmp, text);
  await rename(tmp, path);
}

/** Reads a JSON file, or null when it is absent. */
async function readJsonOrNull(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (e) {
    if (isCode(e, "ENOENT")) return null;
    throw e;
  }
}

/** True when a file exists. */
async function exists(path: string): Promise<boolean> {
  return (await readJsonOrNull(path)) !== null;
}

/** The valid lines of a `dialogs.jsonl`, in order. A missing file is no lines. */
async function readDialogs(path: string): Promise<DialogLine[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (isCode(e, "ENOENT")) return [];
    throw e;
  }
  const out: DialogLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const line = DialogLine.safeParse(JSON.parse(raw) as unknown);
    if (line.success) out.push(line.data);
  }
  return out;
}

/** Writes a file whole or not at all, and only once: temp file, then a hard link (section 9 §10.5). */
async function writeOnce(
  tmpDir: string,
  path: string,
  body: unknown,
): Promise<Outcome<void, "exists" | "write_failed">> {
  const tmp = join(tmpDir, `mailbox-${randomUUID()}.json`);
  try {
    await mkdir(tmpDir, { recursive: true });
    const f = await open(tmp, "wx");
    await f.writeFile(`${JSON.stringify(body, null, 2)}\n`);
    await f.sync();
    await f.close();
    try {
      await link(tmp, path);
    } catch (e) {
      if (isCode(e, "EEXIST")) return fail("exists");
      throw e;
    } finally {
      await rm(tmp, { force: true });
    }
    return ok(undefined);
  } catch {
    return fail("write_failed");
  }
}

/** The run folder of one run. */
const runDir = (d: MailboxDirs, tenant: string, runId: string): string =>
  join(d.evidenceRoot, tenant, "runs", runId);

/** A handle is the request's folder. Why a cast: the Handle brand has no runtime form. */
const toHandle = (dir: string): Handle => dir as unknown as Handle;
const fromHandle = (h: Handle): string => h as unknown as string;

/** Waits `ms`, or returns early when `signal` aborts. Adapters may use timers; core may not. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/** How many events of one request the engine has already handed to the core. */
type Seen = { claimed: boolean; dialogs: number; released: boolean };

/** The engine's side: opens requests, waits for answers, and closes them. */
export class MailboxOperator implements OperatorPort {
  /** Per request folder: what `next` already returned, so each event comes out once. */
  readonly #seen = new Map<string, Seen>();

  constructor(
    private readonly dirs: MailboxDirs,
    private readonly run: { tenant: string; runId: string },
    private readonly pollMs = POLL_MS,
  ) {}

  async open(req: Masked<Intervention>): Promise<Outcome<Handle, "write_failed">> {
    try {
      const box = join(runDir(this.dirs, this.run.tenant, this.run.runId), "mailbox");
      await mkdir(box, { recursive: true });
      const n = (await readdir(box)).length + 1;
      const dir = join(box, `${String(n).padStart(2, "0")}_${req.kind}`);
      await mkdir(dir);
      await writeAtomic(
        this.dirs.tmpDir,
        join(dir, "request.json"),
        `${JSON.stringify(req, null, 2)}\n`,
      );
      return ok(toHandle(dir));
    } catch {
      return fail("write_failed");
    }
  }

  /**
   * Waits for the next event: a claim, a dialog answer, a release, or the decision. Each comes
   * out once, in that order. The core owns the deadline; it aborts `signal` when time is up.
   */
  async next(h: Handle, signal?: AbortSignal): Promise<Outcome<OperatorEvent, "closed">> {
    const dir = fromHandle(h);
    const seen = this.#seen.get(dir) ?? { claimed: false, dialogs: 0, released: false };
    this.#seen.set(dir, seen);
    for (;;) {
      if (signal?.aborted === true || (await exists(join(dir, "closed.json"))))
        return fail("closed");
      if (!seen.claimed) {
        const c = ClaimFile.safeParse(await readJsonOrNull(join(dir, "claim.json")));
        if (c.success) {
          seen.claimed = true;
          return ok({ kind: "claimed", staff: c.data.staff_id, implicit: c.data.implicit });
        }
      }
      const lines = await readDialogs(join(dir, "dialogs.jsonl"));
      const line = lines[seen.dialogs];
      if (line !== undefined) {
        seen.dialogs += 1;
        return ok({ kind: "dialog", staff: line.staff_id, answer: line.answer });
      }
      if (!seen.released) {
        const rel = ReleaseFile.safeParse(await readJsonOrNull(join(dir, "release.json")));
        if (rel.success) {
          seen.released = true;
          const ev: OperatorEvent = { kind: "released", staff: rel.data.staff_id };
          if (rel.data.note !== null) ev.note = rel.data.note;
          return ok(ev);
        }
      }
      const raw = await readJsonOrNull(join(dir, "decision.json"));
      if (raw !== null) {
        const d = DecisionFile.safeParse(raw);
        if (!d.success) return fail("closed", "decision.json does not fit intyy.decision/1.0");
        const ev: OperatorEvent = {
          kind: "decided",
          staff: d.data.staff_id,
          decision: d.data.decision,
        };
        if (d.data.note !== null) ev.note = d.data.note;
        if (d.data.outcome !== null) ev.outcome = d.data.outcome;
        return ok(ev);
      }
      await pause(this.pollMs, signal);
    }
  }

  async close(h: Handle, how: "resolved" | "timed_out" | "run_ended"): Promise<void> {
    const body = { schema: "intyy.closed/1.0", how, at: new Date().toISOString() };
    await writeAtomic(
      this.dirs.tmpDir,
      join(fromHandle(h), "closed.json"),
      `${JSON.stringify(body, null, 2)}\n`,
    );
  }
}

/** The operator CLI's side: finds the open request and writes one decision. */
export class MailboxDesk implements InterventionDesk {
  constructor(private readonly dirs: MailboxDirs) {}

  async openRequest(
    tenant: string,
    runId: string,
  ): Promise<Outcome<OpenRequest | null, "not_found">> {
    const dir = runDir(this.dirs, tenant, runId);
    try {
      await stat(dir);
    } catch (e) {
      if (isCode(e, "ENOENT")) return fail("not_found");
      throw e;
    }
    let folders: string[];
    try {
      folders = (await readdir(join(dir, "mailbox"))).sort();
    } catch (e) {
      if (isCode(e, "ENOENT")) return ok(null);
      throw e;
    }
    for (const folder of folders.reverse()) {
      const box = join(dir, "mailbox", folder);
      if (await exists(join(box, "closed.json"))) continue;
      const request = await readJsonOrNull(join(box, "request.json"));
      if (request === null) continue;
      return ok({
        folder,
        request,
        decided: await exists(join(box, "decision.json")),
        claim: await readJsonOrNull(join(box, "claim.json")),
        released: await exists(join(box, "release.json")),
        runDir: dir,
      });
    }
    return ok(null);
  }

  async decide(
    tenant: string,
    runId: string,
    folder: string,
    decision: Masked<unknown>,
  ): Promise<Outcome<void, "already_decided" | "write_failed">> {
    const box = join(runDir(this.dirs, tenant, runId), "mailbox", folder);
    const tmp = join(this.dirs.tmpDir, `decision-${randomUUID()}.json`);
    try {
      await mkdir(this.dirs.tmpDir, { recursive: true });
      // Why write then link: the name appears whole or not at all, and only once (section 9 §10.5).
      const f = await open(tmp, "wx");
      await f.writeFile(`${JSON.stringify(decision, null, 2)}\n`);
      await f.sync();
      await f.close();
      try {
        await link(tmp, join(box, "decision.json"));
      } catch (e) {
        if (isCode(e, "EEXIST")) return fail("already_decided");
        throw e;
      } finally {
        await rm(tmp, { force: true });
      }
      return ok(undefined);
    } catch {
      return fail("write_failed");
    }
  }
  async claim(
    tenant: string,
    runId: string,
    folder: string,
    claim: Masked<unknown>,
  ): Promise<Outcome<void, "already_claimed" | "write_failed">> {
    const box = join(runDir(this.dirs, tenant, runId), "mailbox", folder);
    const w = await writeOnce(this.dirs.tmpDir, join(box, "claim.json"), claim);
    return w.ok ? w : fail(w.failure === "exists" ? "already_claimed" : "write_failed");
  }

  async release(
    tenant: string,
    runId: string,
    folder: string,
    release: Masked<unknown>,
  ): Promise<Outcome<void, "already_released" | "write_failed">> {
    const box = join(runDir(this.dirs, tenant, runId), "mailbox", folder);
    const w = await writeOnce(this.dirs.tmpDir, join(box, "release.json"), release);
    return w.ok ? w : fail(w.failure === "exists" ? "already_released" : "write_failed");
  }

  async closeRequest(
    tenant: string,
    runId: string,
    folder: string,
    closed: Masked<unknown>,
  ): Promise<Outcome<void, "write_failed">> {
    const box = join(runDir(this.dirs, tenant, runId), "mailbox", folder);
    // Why exclusive: a request that closed on its own (a timeout just before the crash) keeps its
    // own `closed.json`, and the openRequest listing skips it either way.
    const w = await writeOnce(this.dirs.tmpDir, join(box, "closed.json"), closed);
    return w.ok || w.failure === "exists" ? ok(undefined) : fail("write_failed");
  }

  async dialog(
    tenant: string,
    runId: string,
    folder: string,
    line: Masked<unknown>,
  ): Promise<Outcome<void, "write_failed">> {
    const path = join(runDir(this.dirs, tenant, runId), "mailbox", folder, "dialogs.jsonl");
    try {
      let before = "";
      try {
        before = await readFile(path, "utf8");
      } catch (e) {
        if (!isCode(e, "ENOENT")) throw e;
      }
      await writeAtomic(this.dirs.tmpDir, path, `${before}${JSON.stringify(line)}\n`);
      return ok(undefined);
    } catch {
      return fail("write_failed");
    }
  }
}
