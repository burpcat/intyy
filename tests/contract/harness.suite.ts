// Contract suite for the harness port: behavior every implementation must honor when the app
// is allowed and fully featured. Runs against FakeHarness and KvfcuHarness (CONTRACT §8).
// Design section 9 §5.5 and section 8 §6.2, §6.3, §8.
import { describe, expect, test, vi } from "vitest";
import type { FaultLogEntry, Harness, OracleAnswer } from "../../src/ports/harness.js";
import { Secret } from "../../src/ports/secret.js";

/** One implementation under test, plus the hooks a test needs to seed its canned replies. */
export type HarnessFixture = {
  harness: Harness;
  /** Makes the next faultLog() call answer with these entries. */
  seedFaultLog: (entries: readonly FaultLogEntry[]) => void;
  /** Makes an oracle() call for this exact notes text answer with this answer. */
  seedOracle: (notes: string, answer: OracleAnswer) => void;
};

/** Runs the harness contract against one implementation, allowed and fully featured. */
export function harnessContract(label: string, make: () => Promise<HarnessFixture>): void {
  describe(`Harness contract: ${label}`, () => {
    test("features reports every control a fully-featured app offers", async () => {
      const { harness } = await make();
      expect(await harness.features()).toEqual({
        ok: true,
        value: new Set(["reset", "chaos", "named_faults", "fault_log", "oracle", "clock"]),
      });
    });

    test("reset answers ok", async () => {
      const { harness } = await make();
      expect(await harness.reset()).toEqual({ ok: true, value: undefined });
    });

    test("setChaos and setClock answer ok", async () => {
      const { harness } = await make();
      expect(await harness.setChaos({ entropy: 0.25, seed: "run-42" })).toEqual({
        ok: true,
        value: undefined,
      });
      expect(await harness.setClock("2026-01-15")).toEqual({ ok: true, value: undefined });
      expect(await harness.setClock(null)).toEqual({ ok: true, value: undefined });
    });

    test("addFaults rejects the whole batch when an id repeats", async () => {
      const { harness } = await make();
      const first = await harness.addFaults([
        { id: "drop1", kind: "drop_after_confirm", route: "POST /example/path", nth: 1 },
      ]);
      expect(first).toMatchObject({ ok: true });
      const second = await harness.addFaults([
        { id: "other", kind: "server_error", route: "GET /example/other" },
        { id: "drop1", kind: "known_popup", route: "GET /example/dup" },
      ]);
      expect(second).toMatchObject({ ok: false, failure: "rejected" });
    });

    test("clearFaults answers ok", async () => {
      const { harness } = await make();
      expect(await harness.clearFaults()).toEqual({ ok: true, value: undefined });
    });

    test("faultLog parses the app's fault log entries (CONTRACT §6.3)", async () => {
      const { harness, seedFaultLog } = await make();
      const entry: FaultLogEntry = {
        seq: 1,
        time: "2026-01-15T09:00:00.000Z",
        method: "POST",
        path: "/accounts/submit",
        route_count: 1,
        decision: "named",
        fault_kind: "drop_after_confirm",
        block_point: "after",
        style: "hang",
        named_id: "drop1",
        delay_ms: 0,
      };
      seedFaultLog([entry]);
      expect(await harness.faultLog()).toEqual({ ok: true, value: [entry] });
    });

    test("oracle answers with the seeded truth, and never logs or prints the notes value", async () => {
      const { harness, seedOracle } = await make();
      // Why: the notes value is sensitive free-form text (CONTRACT §8); never a canary member.
      const notesValue = "opened for a grandchild's savings, ref 9f31";
      const answer: OracleAnswer = {
        exists: true,
        count: 1,
        accounts: [{ account_number: "400100000159", status: "OPEN", confirmation_number: "KV10000001" }],
      };
      seedOracle(notesValue, answer);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      let result;
      try {
        result = await harness.oracle(new Secret(notesValue));
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
      expect(result).toEqual({ ok: true, value: answer });
      const printed = [...logSpy.mock.calls, ...errSpy.mock.calls]
        .flat()
        .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
        .join("\n");
      expect(printed).not.toContain(notesValue);
    });

    test("an unseeded oracle answer is 'no account found'", async () => {
      const { harness } = await make();
      expect(await harness.oracle(new Secret("no such application was ever opened"))).toEqual({
        ok: true,
        value: { exists: false, count: 0, accounts: [] },
      });
    });
  });
}
