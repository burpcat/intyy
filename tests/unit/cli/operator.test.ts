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

/** The approval block of the default request: the words only, as before the gate's facts. */
const PLAIN_APPROVAL = { words: "Submit Transfer", risk: "irreversible", authorization: "none" };

/** A root with an escalated run and one open approval request. */
async function root(approval: Record<string, unknown> = PLAIN_APPROVAL): Promise<string> {
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
    approval,
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
  test("list shows the open request; show prints the control, screenshot path, and decisions; a bad word, a missing role, and a second answer are refused; decide writes once", async () => {
    const r = await root();
    const got = await call(r, "op_017", ["operator", "list"]);
    expect(got.code).toBe(0);
    expect(got.stdout).toBe(
      `${RUN}  kvfcu/transfer  approval  discovery_irreversible  t7  2026-09-28T14:30:00.000Z  -\n`,
    );

    // show prints the control, the screenshot path, and the allowed decisions
    const shown = await call(r, "op_017", ["operator", "show", RUN]);
    expect(shown.stdout).toContain('control: "Submit Transfer", risk irreversible');
    expect(shown.stdout).toContain(
      join(r, "state", "evidence", "keystone", "runs", RUN, "screens", "00031_observation.png"),
    );
    expect(shown.stdout).toContain(
      "decisions: approve_irreversible | approve_reversible | approve_idempotent | decline",
    );
    // show prints no action or note line for a request without them
    expect(shown.stdout).not.toContain("action:");
    expect(shown.stdout).not.toContain("note:");

    // a word the request does not allow is a usage error, and nothing is written
    const badWord = await call(r, "op_017", ["operator", "decide", RUN, "approve"]);
    expect(badWord.code).toBe(EXIT.usage);
    expect(badWord.stderr).toContain("write one of approve_irreversible");
    expect(existsSync(decisionFile(r))).toBe(false);

    // decide needs the operator role
    expect((await call(r, "op_031", ["operator", "decide", RUN, "decline"])).code).toBe(
      EXIT.refused,
    );

    // decide writes decision.json once; a second answer exits 6
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

  test("show prints the gate's action, rule, path, and the note when they are set, and no note line for a null note", async () => {
    const r = await root({
      ...PLAIN_APPROVAL,
      action: "click",
      rule: "risk.needs_approval",
      path: "/home",
      detail: 'The gate classified "Submit Transfer", but the model named "Transfers".',
    });
    const got = await call(r, "op_017", ["operator", "show", RUN]);
    expect(got.stdout).toContain('control: "Submit Transfer", risk irreversible');
    expect(got.stdout).toContain("action: click, rule risk.needs_approval, path /home");
    expect(got.stdout).toContain(
      'note: The gate classified "Submit Transfer", but the model named "Transfers".',
    );

    const same = await call(
      await root({ ...PLAIN_APPROVAL, action: "click", rule: "risk.unsure", path: null, detail: null }),
      "op_017",
      ["operator", "show", RUN],
    );
    expect(same.stdout).toContain("action: click, rule risk.unsure, path unknown");
    expect(same.stdout).not.toContain("note:");
  });
});
