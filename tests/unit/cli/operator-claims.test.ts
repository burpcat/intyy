// Proves `operator claim | release | dialog | decide --outcome | list --mine` end to end in a
// temporary data root: one claimer wins (exit 6 for the rest), release and dialog need your own
// claim, a release note is masked, `decide` on a claimable takeover needs your claim, and
// `set_outcome` is checked against the request's declared codes. Design section 9 §10.4, §10.5;
// section 7 §13.2; docs/decisions.md, M07. M07 task 2.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { MailboxOperator } from "../../../src/adapters/mailbox/mailbox.js";
import { commands } from "../../../src/cli/commands/index.js";
import { EXIT } from "../../../src/cli/exit-codes.js";
import type { Masked } from "../../../src/ports/masked.js";
import type { Intervention } from "../../../src/ports/operator.js";
import { call as rawCall, cleanRoots, tempRoot } from "./helpers.js";

afterAll(cleanRoots);

const RUN = "run_2026-09-28_7kq2m9x4tb";
const FOLDER = "01_takeover";

/** A root with an escalated run and one open request. `over` replaces request fields. */
async function root(over: Record<string, unknown> = {}, kind = "takeover"): Promise<string> {
  const r = tempRoot();
  for (const d of ["policy", "settings"]) cpSync(join("library", d), join(r, "library", d), { recursive: true });
  const evidence = join(r, "state", "evidence");
  mkdirSync(join(evidence, "keystone", "runs", RUN), { recursive: true });
  // Why a lock file: the crash sweep runs before every command (see operator.test.ts).
  const locksDir = join(r, "state", "var", "locks", "runs");
  mkdirSync(locksDir, { recursive: true });
  writeFileSync(
    join(locksDir, `${RUN}.lock`),
    JSON.stringify({
      schema: "intyy.lock/1.0",
      owner: RUN,
      pid: process.pid,
      host: hostname(),
      command: "replay",
      staff: null,
      started_at: "2026-09-28T14:00:00.000Z",
    }),
  );
  const index = [
    { run_id: RUN, status: "running", capability: "kvfcu/open_sub" },
    { run_id: RUN, status: "escalated", capability: "kvfcu/open_sub" },
  ];
  writeFileSync(join(evidence, "keystone", "index.jsonl"), index.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const port = new MailboxOperator(
    { evidenceRoot: evidence, tmpDir: join(r, "state", "var", "tmp") },
    { tenant: "keystone", runId: RUN },
  );
  const req = {
    schema: "intyy.intervention/1.0",
    run_id: RUN,
    tenant: "keystone",
    capability: "kvfcu/open_sub",
    kind,
    reason: kind === "takeover" ? "stuck" : "no_authorization",
    step: { id: "click_search", intent: null },
    trouble: null,
    ladder: [],
    commit: { state: "none", notice: null },
    operator_note: null,
    approval: kind === "takeover" ? null : { words: null, risk: "irreversible", authorization: "none" },
    screenshot: null,
    decisions: kind === "takeover" ? ["end_run", "set_outcome"] : ["approved", "declined"],
    outcomes: kind === "takeover" ? ["member_not_found"] : [],
    deadline: "2026-09-28T14:30:00.000Z",
    lease: kind === "takeover" ? "nobody" : null,
    on_handback: null,
    opened_at: "2026-09-28T14:00:00.000Z",
    ...over,
  };
  const opened = await port.open(req as unknown as Masked<Intervention>);
  if (!opened.ok) throw new Error("could not open the request");
  return r;
}

const call = (r: string, staff: string, argv: string[], extra: { stdin?: string; stdinTty?: boolean } = {}) =>
  rawCall(argv, { cwd: r, env: { INTYY_STAFF: staff }, deps: { commands }, ...extra });

const mailbox = (r: string, folder: string, file: string) =>
  join(r, "state", "evidence", "keystone", "runs", RUN, "mailbox", folder, file);
const read = (r: string, file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(mailbox(r, FOLDER, file), "utf8")) as Record<string, unknown>;

describe("operator claim", () => {
  test("the first claim writes claim.json; a second operator exits 6", async () => {
    const r = await root();
    const first = await call(r, "op_017", ["operator", "claim", RUN]);
    expect(first.code).toBe(0);
    expect(read(r, "claim.json")).toMatchObject({ schema: "intyy.claim/1.0", staff_id: "op_017", implicit: false });
    const second = await call(r, "op_022", ["operator", "claim", RUN]);
    expect(second.code).toBe(EXIT.refused);
    expect(read(r, "claim.json")).toMatchObject({ staff_id: "op_017" });
  });

  test("claiming twice as the same operator also exits 6", async () => {
    const r = await root();
    await call(r, "op_017", ["operator", "claim", RUN]);
    expect((await call(r, "op_017", ["operator", "claim", RUN])).code).toBe(EXIT.refused);
  });

  test("a concurrent pair of claims has one winner and one exit 6", async () => {
    const r = await root();
    const codes = (
      await Promise.all([call(r, "op_017", ["operator", "claim", RUN]), call(r, "op_022", ["operator", "claim", RUN])])
    ).map((c) => c.code);
    expect(codes.filter((c) => c === 0)).toHaveLength(1);
    expect(codes.filter((c) => c === EXIT.refused)).toHaveLength(1);
  });

  test("an approval cannot be claimed", async () => {
    const r = await root({}, "approval");
    const got = await call(r, "op_017", ["operator", "claim", RUN]);
    expect(got.code).toBe(EXIT.usage);
    expect(existsSync(mailbox(r, "01_approval", "claim.json"))).toBe(false);
  });

  test("a takeover the run cannot take back (lease null) cannot be claimed", async () => {
    const r = await root({ lease: null });
    expect((await call(r, "op_017", ["operator", "claim", RUN])).code).toBe(EXIT.usage);
  });

  test("claim needs the operator role", async () => {
    const r = await root();
    expect((await call(r, "op_031", ["operator", "claim", RUN])).code).toBe(EXIT.refused);
    expect(existsSync(mailbox(r, FOLDER, "claim.json"))).toBe(false);
  });
});

describe("operator release and dialog need your own claim", () => {
  test.each([
    ["release", ["operator", "release", RUN]],
    ["dialog", ["operator", "dialog", RUN, "accept"]],
  ])("%s with no claim exits 6 and writes nothing", async (_name, argv) => {
    const r = await root();
    expect((await call(r, "op_017", argv)).code).toBe(EXIT.refused);
    expect(existsSync(mailbox(r, FOLDER, "release.json"))).toBe(false);
    expect(existsSync(mailbox(r, FOLDER, "dialogs.jsonl"))).toBe(false);
  });

  test.each([
    ["release", ["operator", "release", RUN]],
    ["dialog", ["operator", "dialog", RUN, "dismiss"]],
  ])("%s by an operator who is not the claimer exits 6", async (_name, argv) => {
    const r = await root();
    await call(r, "op_017", ["operator", "claim", RUN]);
    expect((await call(r, "op_022", argv)).code).toBe(EXIT.refused);
    expect(existsSync(mailbox(r, FOLDER, "release.json"))).toBe(false);
    expect(existsSync(mailbox(r, FOLDER, "dialogs.jsonl"))).toBe(false);
  });

  test("release twice exits 6, and the first release stays", async () => {
    const r = await root();
    await call(r, "op_017", ["operator", "claim", RUN]);
    expect((await call(r, "op_017", ["operator", "release", RUN], { stdin: "first note" })).code).toBe(0);
    expect((await call(r, "op_017", ["operator", "release", RUN], { stdin: "second note" })).code).toBe(EXIT.refused);
    expect(read(r, "release.json")).toMatchObject({ note: "first note" });
  });

  test("release with a claim writes release.json; a piped note is read from standard input", async () => {
    const r = await root();
    await call(r, "op_017", ["operator", "claim", RUN]);
    const got = await call(r, "op_017", ["operator", "release", RUN], { stdin: "Filled the form by hand.\n" });
    expect(got.code).toBe(0);
    expect(read(r, "release.json")).toMatchObject({
      schema: "intyy.release/1.0",
      staff_id: "op_017",
      note: "Filled the form by hand.",
    });
  });

  test("release with no piped note (a terminal) writes note null", async () => {
    const r = await root();
    await call(r, "op_017", ["operator", "claim", RUN]);
    expect((await call(r, "op_017", ["operator", "release", RUN], { stdinTty: true })).code).toBe(0);
    expect(read(r, "release.json")).toMatchObject({ note: null });
  });

  test("a release note is masked before it is written (section 9 §10.5: notes pass the text rules)", async () => {
    const r = await root();
    await call(r, "op_017", ["operator", "claim", RUN]);
    await call(r, "op_017", ["operator", "release", RUN], {
      stdin: "Member phone 555-867-5309 and card 4111 1111 1111 1111 were on screen.",
    });
    const text = readFileSync(mailbox(r, FOLDER, "release.json"), "utf8");
    expect(text).not.toContain("867-5309");
    expect(text).not.toContain("4111");
  });

  test("dialog accept and dismiss append lines in order, each with the staff ID", async () => {
    const r = await root();
    await call(r, "op_017", ["operator", "claim", RUN]);
    expect((await call(r, "op_017", ["operator", "dialog", RUN, "accept"])).code).toBe(0);
    expect((await call(r, "op_017", ["operator", "dialog", RUN, "dismiss"])).code).toBe(0);
    const lines = readFileSync(mailbox(r, FOLDER, "dialogs.jsonl"), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l) as unknown)).toMatchObject([
      { staff_id: "op_017", answer: "accept" },
      { staff_id: "op_017", answer: "dismiss" },
    ]);
  });

  test("dialog takes only accept or dismiss", async () => {
    const r = await root();
    await call(r, "op_017", ["operator", "claim", RUN]);
    expect((await call(r, "op_017", ["operator", "dialog", RUN, "maybe"])).code).toBe(EXIT.usage);
    expect(existsSync(mailbox(r, FOLDER, "dialogs.jsonl"))).toBe(false);
  });
});

describe("operator decide on a claimable takeover (section 9 §10.4)", () => {
  test("with no claim it exits 6, and writes nothing", async () => {
    const r = await root();
    expect((await call(r, "op_017", ["operator", "decide", RUN, "end_run"])).code).toBe(EXIT.refused);
    expect(existsSync(mailbox(r, FOLDER, "decision.json"))).toBe(false);
  });

  test("with another operator's claim it exits 6", async () => {
    const r = await root();
    await call(r, "op_017", ["operator", "claim", RUN]);
    expect((await call(r, "op_022", ["operator", "decide", RUN, "end_run"])).code).toBe(EXIT.refused);
    expect(existsSync(mailbox(r, FOLDER, "decision.json"))).toBe(false);
  });

  test("with your own claim it writes decision.json", async () => {
    const r = await root();
    await call(r, "op_017", ["operator", "claim", RUN]);
    expect((await call(r, "op_017", ["operator", "decide", RUN, "end_run"])).code).toBe(0);
    expect(read(r, "decision.json")).toMatchObject({ decision: "end_run", staff_id: "op_017", outcome: null });
  });

  test("an approval needs no claim", async () => {
    const r = await root({}, "approval");
    expect((await call(r, "op_017", ["operator", "decide", RUN, "approved"])).code).toBe(0);
  });

  test("set_outcome needs --outcome, one of the request's declared codes", async () => {
    const r = await root();
    await call(r, "op_017", ["operator", "claim", RUN]);
    expect((await call(r, "op_017", ["operator", "decide", RUN, "set_outcome"])).code).toBe(EXIT.usage);
    expect((await call(r, "op_017", ["operator", "decide", RUN, "set_outcome", "--outcome", "no_such_code"])).code).toBe(
      EXIT.usage,
    );
    expect(existsSync(mailbox(r, FOLDER, "decision.json"))).toBe(false);
  });

  test("set_outcome with a declared code writes it into decision.json", async () => {
    const r = await root();
    await call(r, "op_017", ["operator", "claim", RUN]);
    const got = await call(r, "op_017", ["operator", "decide", RUN, "set_outcome", "--outcome", "member_not_found"]);
    expect(got.stderr).toBe("");
    expect(got.code).toBe(0);
    expect(read(r, "decision.json")).toMatchObject({ decision: "set_outcome", outcome: "member_not_found" });
  });

  test("--outcome with another decision exits 1", async () => {
    const r = await root();
    await call(r, "op_017", ["operator", "claim", RUN]);
    const got = await call(r, "op_017", ["operator", "decide", RUN, "end_run", "--outcome", "member_not_found"]);
    expect(got.code).toBe(EXIT.usage);
    expect(existsSync(mailbox(r, FOLDER, "decision.json"))).toBe(false);
  });
});

describe("operator list and show: who claimed", () => {
  const LINE = `${RUN}  kvfcu/open_sub  takeover  stuck  click_search  2026-09-28T14:30:00.000Z`;

  test("the last column is - while nobody has claimed, and the claimer after", async () => {
    const r = await root();
    expect((await call(r, "op_017", ["operator", "list"])).stdout).toBe(`${LINE}  -\n`);
    await call(r, "op_017", ["operator", "claim", RUN]);
    expect((await call(r, "op_022", ["operator", "list"])).stdout).toBe(`${LINE}  op_017\n`);
  });

  test("--mine keeps only the requests you claimed", async () => {
    const r = await root();
    expect((await call(r, "op_017", ["operator", "list", "--mine"])).stdout).not.toContain(RUN);
    await call(r, "op_017", ["operator", "claim", RUN]);
    expect((await call(r, "op_017", ["operator", "list", "--mine"])).stdout).toBe(`${LINE}  op_017\n`);
    expect((await call(r, "op_022", ["operator", "list", "--mine"])).stdout).not.toContain(RUN);
  });

  test("--json lists claimed_by", async () => {
    const r = await root();
    await call(r, "op_017", ["operator", "claim", RUN]);
    const got = await call(r, "op_017", ["operator", "list", "--json"]);
    const body = JSON.parse(got.stdout) as { requests?: { claimed_by: string | null }[] };
    expect(body.requests?.[0]?.claimed_by).toBe("op_017");
  });

  test("show prints the claimer, or nobody", async () => {
    const r = await root();
    expect((await call(r, "op_017", ["operator", "show", RUN])).stdout).toContain("claimed by: nobody");
    await call(r, "op_017", ["operator", "claim", RUN]);
    expect((await call(r, "op_017", ["operator", "show", RUN])).stdout).toContain("claimed by: op_017");
  });
});
