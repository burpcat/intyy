// The handoff on the live bank app, with a scripted "human" (design section 7 §20 and §21,
// "Handoff"; spec M07, Live rows). A supervised replay of `kvfcu/open_share_subaccount@1` waits at
// its start confirmation. A real key press in the real browser (Tab, which changes nothing on the
// page) is human input: it stops the bot and opens a takeover. The fake operator then claims,
// lets the "person" press Tab again through the same browser, and releases. The engine reverifies,
// takes the lease back, finishes the task, and reads the account number. The test proves who held
// the lease, that the person's input was captured, and that the commit was sent once, by the bot.
// How it reaches the page: `PlaywrightSurface` keeps its page private, so the test wraps
// `chromium.launch` to remember the browser it opens. No product code changes.
// Until the owner's steps are done, `beforeAll` fails with one message naming what is missing.
// Never skips. M07.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { FakeOperator } from "../../src/fakes/operator.js";
import type { LockHold } from "../../src/ports/locks.js";
import { acquireInstanceLock, demoFile, locks, requireSealedDemoArtifact, runOpenSub } from "./replay-demo-kit.js";

const STAFF = "op_017";
const TIMEOUT_MS = 180_000;

let hold: LockHold | null = null;
let cleanup: (() => Promise<void>) | null = null;
const browsers: Browser[] = [];

beforeAll(async () => {
  await requireSealedDemoArtifact();
  hold = await acquireInstanceLock("test:live handoff");
  const launch = chromium.launch.bind(chromium);
  vi.spyOn(chromium, "launch").mockImplementation(async (...args) => {
    const b = await launch(...args);
    browsers.push(b);
    return b;
  });
}, TIMEOUT_MS);

afterAll(async () => {
  vi.restoreAllMocks();
  if (cleanup !== null) await cleanup();
  if (hold !== null) await locks.release(hold);
});

/** The session's one window. */
function page() {
  const p = browsers.at(-1)?.contexts()[0]?.pages()[0];
  if (p === undefined) throw new Error("the replay's browser window is not open");
  return p;
}

test(
  "a person takes over the live session, acts, and hands back; the bot finishes and sends the commit once",
  async () => {
    const operator = new FakeOperator([
      // The start confirmation (supervised mode) stays open until the person's input stops the bot.
      "silent",
      { staff: STAFF, claimed: true },
      { act: () => page().keyboard.press("Tab") },
      { staff: STAFF, released: true, note: "Looked at the screen." },
      // The irreversible OK box asks for approval: the request carries no authorization.
      { staff: STAFF, decision: "approved" },
    ]);
    const running = runOpenSub(demoFile("valid.json"), { operator: () => operator });
    await vi.waitFor(
      () => {
        expect(operator.requests.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 60_000 },
    );
    // The first input: a real key press, trusted by the page, so the capture script reports it.
    await page().keyboard.press("Tab");
    const { outcome, events, remove } = await running;
    cleanup = remove;

    expect(outcome.result.status).toBe("success");
    if (outcome.result.status !== "success") throw new Error("expected success");
    expect(outcome.result.outputs.account_number).toBeTruthy();
    // The bot sent the commit itself, once, after it had the lease back.
    expect(outcome.result.effect).toMatchObject({ commit: "confirmed", performed_by: "bot" });
    expect(events.filter((e) => e.event === "commit_intent")).toHaveLength(1);

    // One takeover, claimed by the staff ID, and handed back.
    expect(outcome.result.interventions).toHaveLength(1);
    expect(outcome.result.interventions[0]).toMatchObject({
      kind: "takeover",
      reason: "unexpected_human_input",
      staff_id: STAFF,
      decision: "handed_back",
    });
    expect(outcome.result.interventions[0]?.human_actions).toBeGreaterThanOrEqual(1);

    // The lease moved claimed, handed back, reverified, in that order.
    const reasons = events.filter((e) => e.event === "lease").map((e) => (e.data as { reason?: string }).reason);
    const at = (r: string): number => reasons.indexOf(r);
    expect(at("claimed")).toBeGreaterThanOrEqual(0);
    expect(at("handed_back")).toBeGreaterThan(at("claimed"));
    expect(at("reverified")).toBeGreaterThan(at("handed_back"));

    // The person's input was captured, as a human action, and no gate line blocked the bot.
    expect(events.some((e) => e.event === "action" && e.by === "human")).toBe(true);
    expect(events.some((e) => e.event === "gate" && (e.data as { decision?: string }).decision === "blocked")).toBe(false);
  },
  TIMEOUT_MS,
);
