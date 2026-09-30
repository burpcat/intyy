// Proves the operator CLI on the three M06 mailbox kinds (design section 9 §10.4; section 7
// §13.1, §13.2; docs/decisions.md M06): `operator decide` refuses a word the request does not
// allow, for `takeover`, `retry_decision`, and `reconciliation_decision`; `operator list` shows
// a replay run waiting on a takeover. Mirrors the M03 `operator.test.ts` pattern. M06 task 4.
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

/** One mailbox kind's own shape, enough to open a request and check a wrong word. */
type KindFixture = {
  kind: Intervention["kind"];
  reason: Intervention["reason"];
  decisions: string[];
  wrongWord: string;
  folder: string;
};

const KINDS: readonly KindFixture[] = [
  { kind: "takeover", reason: "stuck", decisions: ["end_run"], wrongWord: "handed_back", folder: "01_takeover" },
  {
    kind: "retry_decision",
    reason: "retry_needs_approval",
    decisions: ["retry", "no_retry"],
    wrongWord: "retry_now",
    folder: "01_retry_decision",
  },
  {
    kind: "reconciliation_decision",
    reason: "reconciliation_unclear",
    decisions: ["found", "not_found"],
    wrongWord: "maybe",
    folder: "01_reconciliation_decision",
  },
];

/** A root with an escalated run and one open request of `fixture`'s kind. */
async function root(fixture: KindFixture): Promise<string> {
  const r = tempRoot();
  for (const d of ["policy", "settings"]) cpSync(join("library", d), join(r, "library", d), { recursive: true });
  const evidence = join(r, "state", "evidence");
  mkdirSync(join(evidence, "keystone", "runs", RUN), { recursive: true });
  // Why a lock file: the crash sweep runs before every command; a "live" run must hold its
  // lock, or the sweep closes it as crashed before `operator list`/`decide` ever see it.
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
  writeFileSync(
    join(evidence, "keystone", "index.jsonl"),
    index.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  const port = new MailboxOperator(
    { evidenceRoot: evidence, tmpDir: join(r, "state", "var", "tmp") },
    { tenant: "keystone", runId: RUN },
  );
  const req = {
    schema: "intyy.intervention/1.0",
    run_id: RUN,
    tenant: "keystone",
    capability: "kvfcu/open_sub",
    kind: fixture.kind,
    reason: fixture.reason,
    step: { id: "click_confirm", intent: null },
    trouble: fixture.kind === "takeover" ? { phase: "checkpoint", detail: "never arrived" } : null,
    ladder: fixture.kind === "takeover" ? [{ rung: 1, verdict: "climb" }] : [],
    commit: { state: "not_sent", notice: null },
    operator_note: null,
    approval: null,
    screenshot: null,
    decisions: fixture.decisions,
    outcomes: [],
    deadline: "2026-09-28T14:30:00.000Z",
    lease: null,
    on_handback: null,
    opened_at: "2026-09-28T14:00:00.000Z",
  };
  const opened = await port.open(req as unknown as Masked<Intervention>);
  if (!opened.ok) throw new Error("could not open the request");
  return r;
}

const call = (r: string, staff: string, argv: string[]) =>
  rawCall(argv, { cwd: r, env: { INTYY_STAFF: staff }, deps: { commands } });

const decisionFile = (r: string, folder: string) =>
  join(r, "state", "evidence", "keystone", "runs", RUN, "mailbox", folder, "decision.json");

describe("case 3: a wrong word is refused (section 9 §10.4)", () => {
  test.each(KINDS.map((f) => [f.kind, f] as const))("%s: a word the request does not allow is a usage error, and nothing is written", async (_kind, fixture) => {
    const r = await root(fixture);
    const got = await call(r, "op_017", ["operator", "decide", RUN, fixture.wrongWord]);
    expect(got.code).toBe(EXIT.usage);
    expect(got.stderr).toContain(`write one of ${fixture.decisions.join(", ")}`);
    expect(existsSync(decisionFile(r, fixture.folder))).toBe(false);
  });

  test.each(KINDS.map((f) => [f.kind, f] as const))("%s: an allowed word is accepted", async (_kind, fixture) => {
    const r = await root(fixture);
    const first = fixture.decisions[0];
    if (first === undefined) throw new Error("fixture has no decisions");
    const got = await call(r, "op_017", ["operator", "decide", RUN, first]);
    expect(got.code).toBe(0);
    expect(JSON.parse(readFileSync(decisionFile(r, fixture.folder), "utf8"))).toMatchObject({ decision: first });
  });
});

describe("case 6: `operator list` shows a replay waiting on a takeover", () => {
  test("the escalated run, its takeover kind, reason, step, and deadline", async () => {
    const takeover = KINDS[0];
    if (takeover === undefined) throw new Error("no takeover fixture");
    const r = await root(takeover);
    const got = await call(r, "op_017", ["operator", "list"]);
    expect(got.code).toBe(0);
    expect(got.stdout).toBe(
      `${RUN}  kvfcu/open_sub  takeover  stuck  click_confirm  2026-09-28T14:30:00.000Z\n`,
    );
  });
});
