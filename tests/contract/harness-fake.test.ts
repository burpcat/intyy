// Runs the harness contract against FakeHarness, and proves its refusal off test mode.
// Design section 9 §5.5 and section 8 §6.5.
import { describe, expect, test } from "vitest";
import { FakeHarness } from "../../src/fakes/harness.js";
import { Secret } from "../../src/ports/secret.js";
import { harnessContract } from "./harness.suite.js";

harnessContract("fake", () => {
  const harness = new FakeHarness();
  return Promise.resolve({
    harness,
    seedFaultLog: (entries) => {
      harness.seedFaultLog(entries);
    },
    seedOracle: (notes, answer) => {
      harness.seedOracle(notes, answer);
    },
  });
});

// Why: case 4, fake parity with the adapter's environment refusal (build brief, M06 task 6).
describe("FakeHarness off test mode", () => {
  test("every op fails rejected, and features() answers an empty set", async () => {
    const harness = new FakeHarness({ environment: "production" });
    expect(await harness.features()).toEqual({ ok: true, value: new Set() });
    expect(await harness.reset()).toMatchObject({ ok: false, failure: "rejected" });
    expect(await harness.setChaos({ entropy: 0.1 })).toMatchObject({ ok: false, failure: "rejected" });
    expect(
      await harness.addFaults([{ id: "x", kind: "server_error", route: "GET /example" }]),
    ).toMatchObject({ ok: false, failure: "rejected" });
    expect(await harness.clearFaults()).toMatchObject({ ok: false, failure: "rejected" });
    expect(await harness.faultLog()).toMatchObject({ ok: false, failure: "rejected" });
    expect(await harness.oracle(new Secret("some notes"))).toMatchObject({
      ok: false,
      failure: "rejected",
    });
    expect(await harness.setClock("2026-01-15")).toMatchObject({ ok: false, failure: "rejected" });
  });
});
