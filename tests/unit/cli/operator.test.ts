// Proves `operator list | show | decide` end to end in a temporary data root: the open request
// is listed and shown, a decision is written once, and a bad word or role is refused.
// Design section 9 §10.4, §10.5; section 4 §7.7. M03 task 8.
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

/** A root with an escalated run and one open approval request. */
async function root(): Promise<string> {
  const r = tempRoot();
  for (const d of ["policy", "settings"])
    cpSync(join("library", d), join(r, "library", d), { recursive: true });
  const evidence = join(r, "state", "evidence");
  mkdirSync(join(evidence, "keystone", "runs", RUN), { recursive: true });
  // Why a lock file: the crash sweep (M05 task 10) now runs before every command. A "live" run
  // in this fixture must hold its run lock, the same way a real discovery would, or the sweep
  // closes it as crashed before `operator list` ever sees it (section 7 §17).
  const locksDir = join(r, "state", "var", "locks", "runs");
  mkdirSync(locksDir, { recursive: true });
  writeFileSync(
    join(locksDir, `${RUN}.lock`),
    JSON.stringify({
      schema: "intyy.lock/1.0",
      owner: RUN,
      pid: process.pid,
      host: hostname(),
      command: "discover",
      staff: null,
      started_at: "2026-09-28T14:00:00.000Z",
    }),
  );
  const index = [
    { run_id: RUN, status: "running", capability: "kvfcu/transfer" },
    { run_id: RUN, status: "escalated", capability: "kvfcu/transfer" },
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
    capability: "kvfcu/transfer",
    kind: "approval",
    reason: "discovery_irreversible",
    step: { id: "t7", intent: null },
    trouble: null,
    ladder: [],
    commit: { state: "none" },
    operator_note: null,
    approval: { words: "Submit Transfer", risk: "irreversible", authorization: "none" },
    screenshot: "screens/00031_observation.png",
    decisions: ["approve_irreversible", "approve_reversible", "approve_idempotent", "decline"],
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

const decisionFile = (r: string) =>
  join(r, "state", "evidence", "keystone", "runs", RUN, "mailbox", "01_approval", "decision.json");

describe("operator commands", () => {
  test("list shows the open request", async () => {
    const r = await root();
    const got = await call(r, "op_017", ["operator", "list"]);
    expect(got.code).toBe(0);
    expect(got.stdout).toBe(
      `${RUN}  kvfcu/transfer  approval  discovery_irreversible  t7  2026-09-28T14:30:00.000Z\n`,
    );
  });

  test("show prints the control, the screenshot path, and the allowed decisions", async () => {
    const r = await root();
    const got = await call(r, "op_017", ["operator", "show", RUN]);
    expect(got.stdout).toContain('control: "Submit Transfer", risk irreversible');
    expect(got.stdout).toContain(
      join(r, "state", "evidence", "keystone", "runs", RUN, "screens", "00031_observation.png"),
    );
    expect(got.stdout).toContain(
      "decisions: approve_irreversible | approve_reversible | approve_idempotent | decline",
    );
  });

  test("decide writes decision.json once; a second answer exits 6", async () => {
    const r = await root();
    const first = await call(r, "op_017", ["operator", "decide", RUN, "approve_idempotent"]);
    expect(first.code).toBe(0);
    expect(JSON.parse(readFileSync(decisionFile(r), "utf8"))).toMatchObject({
      schema: "intyy.decision/1.0",
      staff_id: "op_017",
      decision: "approve_idempotent",
      outcome: null,
      note: null,
    });
    expect((await call(r, "op_017", ["operator", "decide", RUN, "decline"])).code).toBe(
      EXIT.refused,
    );
  });

  test("a word the request does not allow is a usage error, and nothing is written", async () => {
    const r = await root();
    const got = await call(r, "op_017", ["operator", "decide", RUN, "approve"]);
    expect(got.code).toBe(EXIT.usage);
    expect(got.stderr).toContain("write one of approve_irreversible");
    expect(existsSync(decisionFile(r))).toBe(false);
  });

  test("decide needs the operator role", async () => {
    const r = await root();
    expect((await call(r, "op_031", ["operator", "decide", RUN, "decline"])).code).toBe(
      EXIT.refused,
    );
  });
});
