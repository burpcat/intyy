// Proves the mailbox writes its files atomically: request.json, claim.json, release.json,
// dialogs.jsonl, decision.json, and closed.json each appear whole or not at all, and no temp file
// is left behind, on success or refusal. Design section 9 §10.5 ("temp file, then rename or
// link"); section 7 §13.4; M07 gate row "Mailbox: ... atomic writes". Follows the style of
// tests/contract/files.test.ts ("atomic writes leave no temp files behind"). Synthetic values only.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MailboxDesk, MailboxOperator } from "../../../src/adapters/mailbox/mailbox.js";
import type { Masked } from "../../../src/ports/masked.js";
import type { Intervention } from "../../../src/ports/operator.js";
import { tempRoot } from "../safety/canary-kit.js";

const RUN = "run_2026-09-28_7kq2m9x4tb";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A mailbox in a temp folder: the engine's side, the CLI's desk, and the paths. */
async function setup(tmpName = "tmp") {
  const { root, remove } = await tempRoot("intyy-mail-atomic-");
  cleanups.push(remove);
  const dirs = { evidenceRoot: join(root, "evidence"), tmpDir: join(root, tmpName) };
  const port = new MailboxOperator(dirs, { tenant: "keystone", runId: RUN }, 5);
  const desk = new MailboxDesk(dirs);
  return { root, dirs, port, desk };
}

/** A made-up request. `pad` makes the file big, so a torn write would show. */
const request = (pad = ""): Masked<Intervention> =>
  ({ schema: "intyy.intervention/1.0", kind: "takeover", run_id: RUN, note: pad }) as unknown as Masked<Intervention>;
const masked = (body: object): Masked<unknown> => body as unknown as Masked<unknown>;
const claim = (staff: string, pad = "") => masked({ schema: "intyy.claim/1.0", staff_id: staff, at: "2026-09-28T14:01:00.000Z", implicit: false, pad });

const FOLDER = "01_takeover";

/** Every file name in `dir`, or none when it does not exist. */
const namesIn = async (dir: string): Promise<string[]> => (existsSync(dir) ? readdir(dir) : []);

describe("every mailbox file is written whole, and no temp file is left behind (section 9 §10.5)", () => {
  test("a full life of one request: open, claim, dialog, release, decide, close", async () => {
    const { dirs, port, desk } = await setup();
    const opened = await port.open(request());
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("open failed");
    const box = join(dirs.evidenceRoot, "keystone", "runs", RUN, "mailbox", FOLDER);

    expect(await desk.claim("keystone", RUN, FOLDER, claim("op_017"))).toEqual({ ok: true, value: undefined });
    expect(await desk.dialog("keystone", RUN, FOLDER, masked({ staff_id: "op_017", at: "2026-09-28T14:02:00.000Z", answer: "accept" }))).toEqual({ ok: true, value: undefined });
    expect(await desk.dialog("keystone", RUN, FOLDER, masked({ staff_id: "op_017", at: "2026-09-28T14:02:01.000Z", answer: "dismiss" }))).toEqual({ ok: true, value: undefined });
    expect(await desk.release("keystone", RUN, FOLDER, masked({ schema: "intyy.release/1.0", staff_id: "op_017", at: "2026-09-28T14:03:00.000Z", note: null }))).toEqual({ ok: true, value: undefined });
    expect(await desk.decide("keystone", RUN, FOLDER, masked({ schema: "intyy.decision/1.0", staff_id: "op_017", at: "2026-09-28T14:04:00.000Z", decision: "handed_back", outcome: null, note: null }))).toEqual({ ok: true, value: undefined });
    await port.close(opened.value, "resolved");

    // Every file is there, and each parses whole (dialogs.jsonl line by line).
    expect((await readdir(box)).sort()).toEqual(["claim.json", "closed.json", "decision.json", "dialogs.jsonl", "release.json", "request.json"]);
    for (const name of ["request.json", "claim.json", "release.json", "decision.json", "closed.json"]) {
      expect(() => { JSON.parse(readFileSync(join(box, name), "utf8")); }, name).not.toThrow();
    }
    const lines = readFileSync(join(box, "dialogs.jsonl"), "utf8").split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.filter((l) => l !== "").map((l) => (JSON.parse(l) as { answer: string }).answer)).toEqual(["accept", "dismiss"]);
    // The shared temp folder holds nothing: each write renamed or linked its temp file away.
    expect(await namesIn(dirs.tmpDir)).toEqual([]);
  });

  test("a refused second write (claim, release, decision, closed) leaves the first file and no temp file", async () => {
    const { dirs, port, desk } = await setup();
    const opened = await port.open(request());
    if (!opened.ok) throw new Error("open failed");
    const box = join(dirs.evidenceRoot, "keystone", "runs", RUN, "mailbox", FOLDER);

    expect(await desk.claim("keystone", RUN, FOLDER, claim("op_017"))).toMatchObject({ ok: true });
    const first = readFileSync(join(box, "claim.json"), "utf8");
    expect(await desk.claim("keystone", RUN, FOLDER, claim("op_022"))).toMatchObject({ ok: false, failure: "already_claimed" });
    expect(readFileSync(join(box, "claim.json"), "utf8")).toBe(first);

    const rel = masked({ schema: "intyy.release/1.0", staff_id: "op_017", at: "2026-09-28T14:03:00.000Z", note: null });
    expect(await desk.release("keystone", RUN, FOLDER, rel)).toMatchObject({ ok: true });
    expect(await desk.release("keystone", RUN, FOLDER, rel)).toMatchObject({ ok: false, failure: "already_released" });

    const dec = masked({ schema: "intyy.decision/1.0", staff_id: "op_017", at: "2026-09-28T14:04:00.000Z", decision: "end_run", outcome: null, note: null });
    expect(await desk.decide("keystone", RUN, FOLDER, dec)).toMatchObject({ ok: true });
    expect(await desk.decide("keystone", RUN, FOLDER, dec)).toMatchObject({ ok: false, failure: "already_decided" });

    expect(await desk.closeRequest("keystone", RUN, FOLDER, masked({ schema: "intyy.closed/1.0", how: "run_ended", at: "2026-09-28T14:05:00.000Z" }))).toMatchObject({ ok: true });
    expect(await desk.closeRequest("keystone", RUN, FOLDER, masked({ schema: "intyy.closed/1.0", how: "timed_out", at: "2026-09-28T14:06:00.000Z" }))).toMatchObject({ ok: true });
    expect((JSON.parse(readFileSync(join(box, "closed.json"), "utf8")) as { how: string }).how).toBe("run_ended");

    expect(await namesIn(dirs.tmpDir)).toEqual([]);
  });
});

describe("a reader never sees a partial file (section 9 §10.5)", () => {
  test("while claim.json is being created, every look finds nothing or the whole body", async () => {
    const { dirs, port, desk } = await setup();
    const opened = await port.open(request());
    if (!opened.ok) throw new Error("open failed");
    const path = join(dirs.evidenceRoot, "keystone", "runs", RUN, "mailbox", FOLDER, "claim.json");

    // Why a big pad: a plain in-place write of a few MB spans many disk writes, so a reader would catch it half done.
    const pad = "x".repeat(4_000_000);
    const state = { done: false };
    const writer = desk.claim("keystone", RUN, FOLDER, claim("op_017", pad)).finally(() => {
      state.done = true;
    });
    while (!state.done) {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { pad: string };
        expect(parsed.pad.length).toBe(pad.length);
      }
      await new Promise((r) => setImmediate(r));
    }
    expect(await writer).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ staff_id: "op_017" });
  });

  test("while dialogs.jsonl grows, every look finds only whole lines", async () => {
    const { dirs, port, desk } = await setup();
    const opened = await port.open(request());
    if (!opened.ok) throw new Error("open failed");
    const path = join(dirs.evidenceRoot, "keystone", "runs", RUN, "mailbox", FOLDER, "dialogs.jsonl");

    const state = { done: false };
    const writer = (async () => {
      for (let i = 0; i < 40; i++) {
        const r = await desk.dialog("keystone", RUN, FOLDER, masked({ staff_id: "op_017", at: "2026-09-28T14:02:00.000Z", answer: i % 2 === 0 ? "accept" : "dismiss", pad: "y".repeat(50_000) }));
        expect(r).toMatchObject({ ok: true });
      }
      state.done = true;
    })();
    while (!state.done) {
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8");
        expect(text.endsWith("\n")).toBe(true);
        for (const l of text.split("\n").filter((x) => x !== "")) expect(() => { JSON.parse(l); }).not.toThrow();
      }
      await new Promise((r) => setImmediate(r));
    }
    await writer;
    expect(readFileSync(path, "utf8").split("\n").filter((x) => x !== "")).toHaveLength(40);
    expect(await namesIn(dirs.tmpDir)).toEqual([]);
  });
});

describe("a write that cannot finish leaves no final file (section 9 §10.5)", () => {
  test("a temp folder that is really a file: open, claim, and decide say write_failed, and no file appears", async () => {
    const { dirs, port, desk } = await setup("not-a-folder");
    await writeFile(dirs.tmpDir, "in the way");
    // The request folder exists (a run with a mailbox); only the temp folder is broken.
    const box = join(dirs.evidenceRoot, "keystone", "runs", RUN, "mailbox", FOLDER);
    await mkdir(box, { recursive: true });

    expect(await desk.claim("keystone", RUN, FOLDER, claim("op_017"))).toMatchObject({ ok: false, failure: "write_failed" });
    expect(await desk.decide("keystone", RUN, FOLDER, masked({ schema: "intyy.decision/1.0", decision: "end_run" }))).toMatchObject({ ok: false, failure: "write_failed" });
    expect(await desk.closeRequest("keystone", RUN, FOLDER, masked({ schema: "intyy.closed/1.0", how: "run_ended" }))).toMatchObject({ ok: false, failure: "write_failed" });
    expect(await namesIn(box)).toEqual([]);

    const opened = await port.open(request());
    expect(opened).toMatchObject({ ok: false, failure: "write_failed" });
    // The second request folder was made, but no request.json is half written inside it.
    expect(existsSync(join(dirs.evidenceRoot, "keystone", "runs", RUN, "mailbox", "02_takeover", "request.json"))).toBe(false);
  });
});
