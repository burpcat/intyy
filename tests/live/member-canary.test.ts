// The member canary (design section 4 §14, "How the canary scans work"; CLAUDE.md, the canary
// seed member): replays `kvfcu/open_share_subaccount@1` for the tenant's own canary member, in a
// temp data root, then scans every file that run wrote for the member's number and every
// value the run returned. One hit fails the test. `kvfcu/open_share_subaccount` is not sealed
// yet (the owner's M05 steps run after this task): this test fails loudly, with a clear
// message, until it is. Never skip. M05 task 13.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { scanForCanaries } from "../../src/core/safety/canary/scan.js";
import type { LockHold } from "../../src/ports/locks.js";
import { readTree } from "../unit/safety/canary-kit.js";
import { acquireInstanceLock, config, locks, requireSealedDemoArtifact, runOpenSub } from "./replay-demo-kit.js";

let hold: LockHold | null = null;

beforeAll(async () => {
  await requireSealedDemoArtifact();
  hold = await acquireInstanceLock("test:live member-canary");
});

afterAll(async () => {
  if (hold !== null) await locks.release(hold);
});

describe("the member canary (section 4 §14)", () => {
  test("replaying for the canary member leaks it nowhere, in any written file", async () => {
    // Why read at run time, never hardcode: the number itself is intyy.json's own config
    // (CLAUDE.md names a seed member today, but this test must track whatever the config says).
    const canary = config.canary_members[0];
    if (canary === undefined) throw new Error("intyy.json has no canary_members configured");

    // A made-up deposit: no member data of its own, so it never confuses the scan.
    const { outcome, root, remove } = await runOpenSub({ member_id: canary, deposit: "137.00" });
    try {
      const markers = [canary];
      if (outcome.result.status === "success") {
        for (const value of Object.values(outcome.result.outputs)) markers.push(String(value));
      }
      const files = await readTree(root);
      expect(scanForCanaries(files, markers)).toEqual([]);
    } finally {
      await remove();
    }
  });
});
