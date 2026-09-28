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
import { DecisionFile } from "../../core/model/mailbox.js";
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

/** The engine's side: opens requests, waits for answers, and closes them. */
export class MailboxOperator implements OperatorPort {
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

  /** Waits for `decision.json`. The core owns the deadline; it aborts `signal` when time is up. */
  async next(h: Handle, signal?: AbortSignal): Promise<Outcome<OperatorEvent, "closed">> {
    const dir = fromHandle(h);
    for (;;) {
      if (signal?.aborted === true || (await exists(join(dir, "closed.json"))))
        return fail("closed");
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
}
