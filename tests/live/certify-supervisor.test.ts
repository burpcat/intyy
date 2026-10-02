// `certify case kvfcu/open_share_subaccount@1.0.0 --class valid --profile supervisor_needed` on
// the live bank app, with the scripted operator (the default; spec M07, Live rows; updates file
// §11.1 and §13.2). `supervisor_needed` is a suite `extra` case (section 8 §6.1): kvfcu's review page
// disables Confirm and asks for a supervisor (M07 capture, 2026-10-02), the `needs_human` handler matches, the run opens a takeover, and the
// scripted operator ends it (section 8 §7.6). The case ends `escalated` with detail
// `takeover/needs_human_handler/<step>`, the suite's own expectation, so the verdict is `pass`.
// Until the owner's steps are done (the sealed artifact, the approved library files, and the
// suite's `supervisor_needed` case), `beforeAll` fails with one message naming what is missing.
// Never skips. M07.
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { FileDocumentStore } from "../../src/adapters/files/document-store.js";
import { suiteKind } from "../../src/core/model/kinds.js";
import type { LockHold } from "../../src/ports/locks.js";
import { CASE_TIMEOUT_MS, KEY, certifyCase, requireCertifyPrereqs, type CaseRun } from "./certify-kit.js";
import { ROOT, acquireInstanceLock, clock, config, locks } from "./replay-demo-kit.js";

const CASE = "supervisor_needed";
const SUITE_ID = "kvfcu/open_share_subaccount@1";

let hold: LockHold | null = null;
let run: CaseRun | null = null;

/** Fails with a clear message unless the newest approved suite holds the `supervisor_needed` case. */
async function requireSuiteCase(): Promise<void> {
  const tmpDir = join(ROOT, config.state, "var", "tmp");
  const store = new FileDocumentStore(suiteKind, { dir: join(ROOT, config.library, "suites"), tmpDir }, clock);
  const rev = (await store.list({ id: SUITE_ID })).filter((s) => s.state === "approved").at(-1)?.rev;
  const got = rev === undefined ? undefined : await store.get(SUITE_ID, rev);
  if (got === undefined || !got.ok || !got.value.doc.extra.some((e) => e.id === CASE)) {
    throw new Error(
      `M07 live certify test cannot run yet. Missing owner step: the approved suite ${SUITE_ID} has no extra case ${CASE}. ` +
        `Add it (the supervisor_required fault, expecting an escalation), seal, and approve the suite.`,
    );
  }
}

beforeAll(async () => {
  await requireCertifyPrereqs();
  await requireSuiteCase();
  hold = await acquireInstanceLock("test:live certify-supervisor");
}, CASE_TIMEOUT_MS);

afterAll(async () => {
  if (run !== null) await run.remove();
  if (hold !== null) await locks.release(hold);
});

test(
  "supervisor_needed with the scripted operator: escalated at a takeover, the suite's own expectation",
  async () => {
    run = await certifyCase(CASE);
    const c = run.report.cases[0];
    expect(c?.result.status).toBe("escalated");
    expect(c?.result.detail).toMatch(/^takeover\/needs_human_handler\/.+$/);
    expect(c?.verdict).toBe("pass");
    expect(run.plan.pin).toBe(KEY);
    // The scripted operator, not a mailbox: nobody waited for a person.
    expect(run.plan.operator).toBe("scripted");
    // The supervisor request stops the run at Confirm, before the commit step (OK): nothing sent.
    expect(c?.result.detail).toBe("takeover/needs_human_handler/click_confirm");
    expect(run.commit).toBe("not_sent");
  },
  CASE_TIMEOUT_MS,
);
