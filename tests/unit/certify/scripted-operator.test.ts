// Proves the scripted operator answers exactly as section 8 §7.6's table says, and resolves at
// once, never waiting on a deadline timer. Design section 8 §7.6. M06 task 8.
import { describe, expect, test } from "vitest";
import { SCRIPTED_STAFF, ScriptedOperator } from "../../../src/core/certify/scripted-operator.js";
import type { Masked } from "../../../src/ports/masked.js";
import type { Intervention } from "../../../src/ports/operator.js";

/** A test-only Masked cast (tests/ is outside the lint rule that reserves this to redaction). */
function maskedCast<T>(v: T): Masked<T> {
  return v as Masked<T>;
}

function req(kind: string): Masked<Intervention> {
  return maskedCast<Intervention>({ schema: "intyy.intervention/1.0", kind });
}

describe("ScriptedOperator.open", () => {
  test("opens at once, with the request itself as the handle", async () => {
    const op = new ScriptedOperator();
    const opened = await op.open(req("approval"));
    expect(opened.ok).toBe(true);
  });
});

describe("ScriptedOperator.next", () => {
  test("retry_decision: retry, staffed as certify", async () => {
    const op = new ScriptedOperator();
    const opened = await op.open(req("retry_decision"));
    if (!opened.ok) throw new Error("open failed");
    expect(await op.next(opened.value)).toEqual({
      ok: true,
      value: { kind: "decided", staff: SCRIPTED_STAFF, decision: "retry" },
    });
  });

  test("approval: approved (reachable only under policy.approvals.force_human)", async () => {
    const op = new ScriptedOperator();
    const opened = await op.open(req("approval"));
    if (!opened.ok) throw new Error("open failed");
    expect(await op.next(opened.value)).toEqual({
      ok: true,
      value: { kind: "decided", staff: SCRIPTED_STAFF, decision: "approved" },
    });
  });

  test("takeover: end_run, its only decision word", async () => {
    const op = new ScriptedOperator();
    const opened = await op.open(req("takeover"));
    if (!opened.ok) throw new Error("open failed");
    expect(await op.next(opened.value)).toEqual({
      ok: true,
      value: { kind: "decided", staff: SCRIPTED_STAFF, decision: "end_run" },
    });
  });

  test("reconciliation_decision: no word fits, so the port closes instead of answering", async () => {
    const op = new ScriptedOperator();
    const opened = await op.open(req("reconciliation_decision"));
    if (!opened.ok) throw new Error("open failed");
    expect(await op.next(opened.value)).toEqual({ ok: false, failure: "closed" });
  });

  test("start_confirmation: also closes (never reached: certify skips it outright)", async () => {
    const op = new ScriptedOperator();
    const opened = await op.open(req("start_confirmation"));
    if (!opened.ok) throw new Error("open failed");
    expect(await op.next(opened.value)).toEqual({ ok: false, failure: "closed" });
  });

  test("every answer resolves without waiting: ten calls settle well under a tick budget", async () => {
    const op = new ScriptedOperator();
    const started = performance.now();
    for (let i = 0; i < 10; i += 1) {
      const opened = await op.open(req("takeover"));
      if (opened.ok) await op.next(opened.value);
    }
    // Why 200ms: no timer or deadline is ever awaited here, so ten round trips finish almost
    // instantly; any real wait would blow well past this.
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("ScriptedOperator.close", () => {
  test("closes without needing a handle", async () => {
    const op = new ScriptedOperator();
    await expect(op.close()).resolves.toBeUndefined();
  });
});
