// Proves, on the live bank app, that a `quick` certify batch on keystone with the instance flag
// off passes: `certify kvfcu/open_share_subaccount@1.0.3 --kind quick`, no `--instance`. The
// gate passes; it is a drill only through `--models off`, and with faked models it is none (design section 8 §7.1; section 9 §9.1, §9.2). Needs the
// owner's sealed artifact, approved suite, test data, faults, and packs: until they exist,
// `beforeAll` fails with one message naming what is missing. Never skips. The instance lock is
// held for the file. M08 gate row "A quick batch on keystone, flag off, passes". M10 gate row "a
// quick batch passes on the bank app with jev and the reviewer faked": the same batch, with a
// table classifier and a table reviewer swapped into the wiring by the TEST (made-up key variables,
// no call leaves the machine; the real library's global policy has `replay_jev` and
// `replay_reviewer` on). Both fakes are unsure, so neither decides an outcome nor says "found".
import { afterAll, beforeAll, expect, test } from "vitest";
import { TableClassifier } from "../../src/fakes/table-classifier.js";
import { TableReviewer } from "../../src/fakes/table-reviewer.js";
import type { LockHold } from "../../src/ports/locks.js";
import { acquireInstanceLock, locks } from "./replay-demo-kit.js";
import { QUICK_TIMEOUT_MS, certifyQuick, requireCertifyPrereqs, type QuickRun } from "./certify-kit.js";

let hold: LockHold | null = null;
let batch: QuickRun | null = null;
const extra: QuickRun[] = [];

beforeAll(async () => {
  await requireCertifyPrereqs();
  hold = await acquireInstanceLock("test:live certify-quick");
}, 60_000);

afterAll(async () => {
  if (batch !== null) await batch.remove();
  for (const b of extra) await b.remove();
  if (hold !== null) await locks.release(hold);
});

// Why a drill: with no fakes the kit runs `--models off`, and a `--models off` batch is a drill
// (section 8 §7.1). No instance difference is declared; the next test proves "not a drill".
test(
  "a quick batch with no --instance passes the gate; a drill only because models are off",
  async () => {
    batch = await certifyQuick();
    expect(batch.report.gate.passed).toBe(true);
    expect(batch.code).toBe(0);
    expect(batch.report.drill).toBe(true);
    expect(batch.plan.models_off).toBe(true);
    expect(batch.plan.declaration).toBeUndefined();
    expect(batch.plan.kind).toBe("quick");
    expect(batch.report.cases.map((c) => c.case_id)).toContain("baseline");
  },
  QUICK_TIMEOUT_MS,
);

test(
  "a quick batch passes with jev and the reviewer faked, and is not a drill",
  async () => {
    const jev = new TableClassifier({
      trouble: [
        { when: {}, reply: { answer: { bucket: "needs_review", handler: null, outcome: null, confidence: 0.5 } } },
      ],
      reconcile: [{ when: {}, reply: { answer: { verdict: "unclear", confidence: 0.5 } } }],
    });
    const reviewer = new TableReviewer({
      fixStep: [{ when: {}, reply: { answer: { give_up: true, reason: "No safe fix." } } }],
      secondOpinion: [{ when: {}, reply: { answer: { verdict: "unclear", confidence: 0.5 } } }],
    });
    const run = await certifyQuick([], {
      wire: { classifier: () => jev, jevVersion: "jev-1.13.0", reviewer: () => reviewer },
    });
    extra.push(run);
    expect(run.report.gate.passed).toBe(true);
    expect(run.code).toBe(0);
    expect(run.report.drill).toBeUndefined();
    expect(run.plan.kind).toBe("quick");
    expect(run.report.cases.map((c) => c.case_id)).toContain("baseline");
  },
  QUICK_TIMEOUT_MS,
);
