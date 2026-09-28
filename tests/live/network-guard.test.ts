// The network guard on the live bank app: the NCUA footer link, a redirect off the list, and a
// jump to `/__test__/faultlog` are all blocked. The gate allows each action first, so the guard
// is what is tested. It also saves one masked screenshot of the start page for the owner check.
// Touches only the bank app's base URL, its NCUA link, and a blocked `/__test__/` jump (spec M02).
// Design section 4 §6.8, §9.11, §14 ("Network guard"); section 9 §12.2 (instance lock); M02 task 12.
// Set INTYY_VISIBLE=1 to watch it in a visible browser.
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { playwrightFactory } from "../../src/adapters/playwright/session.js";
import { FileEvidenceStore } from "../../src/adapters/files/other-stores.js";
import { FileLockSlots, systemLockEnv } from "../../src/adapters/files/locks.js";
import { SystemClock } from "../../src/adapters/system/clock.js";
import { SystemIds } from "../../src/adapters/system/ids.js";
import { capture } from "../../src/core/capture/capture.js";
import { LockManager } from "../../src/core/locks/manager.js";
import type { GateAction, GateResult } from "../../src/core/safety/gate/gate.js";
import { Redactor, redactionRules } from "../../src/core/safety/redaction/redactor.js";
import type { LockHold } from "../../src/ports/locks.js";
import type { Observation, SurfaceEvent } from "../../src/ports/surface.js";
import {
  LEASE,
  gateConfig,
  openTestGate,
  testPolicy,
  type Opened,
} from "../contract/surface/gate-kit.js";
import { tempRoot } from "../unit/safety/canary-kit.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

/** The bank app's only entry point (CONTRACT §1). */
const BANK = "http://127.0.0.1:8080";
const VISIBLE = process.env.INTYY_VISIBLE === "1";
const NCUA = "https://www.ncua.gov";

/**
 * The tiny test policy: the start page, the helper's two pages, and `/__test__/*` denied.
 * `/` forwards to the login page, `/login.do`. The owner named it (decisions.md, M02).
 */
const policy = testPolicy({
  allow: ["/", "/login.do", "/redirect", "/jump"],
  deny: ["/__test__/*"],
  irreversible: [],
});

const clock = new SystemClock();
const locks = new LockManager(
  new FileLockSlots(join(import.meta.dirname, "../../state/var/locks")),
  clock,
  systemLockEnv(),
);
let hold: LockHold | null = null;
let helper: FixtureServer;
let g: Opened;
let events: AsyncIterator<SurfaceEvent>;

beforeAll(async () => {
  // Why: CONTRACT §2 and section 9 §12.2, one run at a time on the instance.
  const taken = await locks.acquire("instance", "http_127.0.0.1_8080", {
    owner: new SystemIds(clock).runId(),
    command: "test:live network-guard",
    staff: null,
    waitMs: 0,
  });
  if (!taken.ok) throw new Error(`the bank app is busy: ${taken.detail ?? ""}`);
  hold = taken.value;
  helper = await startFixtureServer(BANK);
  const cfg = gateConfig(BANK, policy, [helper.origin], VISIBLE);
  try {
    g = await openTestGate(playwrightFactory(), cfg, policy);
  } catch {
    throw new Error("the bank app does not answer at 127.0.0.1:8080. Start it, then run again.");
  }
  events = g.eyes.events()[Symbol.asyncIterator]();
});

afterAll(async () => {
  await g.gate.close();
  await helper.close();
  if (hold !== null) await locks.release(hold);
});

/** Waits a moment when a human is watching. */
const pause = (): Promise<void> =>
  VISIBLE ? new Promise((r) => setTimeout(r, 1500)) : Promise.resolve();

/** Proposes one discovery action as the LLM, with a human yes. */
async function act(action: GateAction): Promise<GateResult> {
  const r = await g.gate.act({
    actor: "llm",
    lease: LEASE,
    action,
    step: null,
    approval: { by: "op_022" },
  });
  if (!r.ok) throw new Error(`act failed: ${r.failure}`);
  return r.value;
}

/** Reads events until the guard blocks something, or fails after ten seconds. */
async function nextBlock(): Promise<Extract<SurfaceEvent, { kind: "network_blocked" }>> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("the guard blocked nothing"));
    }, 10_000);
  });
  try {
    for (;;) {
      const next = await Promise.race([events.next(), deadline]);
      if (next.done === true) throw new Error("events ended");
      if (next.value.kind === "network_blocked" && next.value.request === "document") {
        return next.value;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Observes, or fails the test. */
async function look(): Promise<Observation> {
  const o = await g.eyes.observe();
  if (!o.ok) throw new Error(`observe failed: ${o.failure}`);
  return o.value;
}

test("the start page loads inside the tiny policy", async () => {
  const o = await look();
  // Why: if the start page redirects elsewhere, the guard leaves a blank window. Stop and ask
  // the owner which path to allow; never probe the app to find out (CLAUDE.md, the bank app).
  expect(new URL(o.url).origin, "the start page left the bank origin or was blocked").toBe(BANK);
});

test("one masked screenshot of the start page is saved for the owner check", async () => {
  const t = await tempRoot("intyy-live-evidence-");
  const store = new FileEvidenceStore({
    root: join(t.root, "evidence"),
    tmpDir: join(t.root, "tmp"),
  });
  const folder = await store.createRun("keystone", new SystemIds(clock).runId());
  if (!folder.ok) throw new Error("no run folder");
  const r = new Redactor(redactionRules(policy));
  const got = await capture(
    g.eyes,
    r,
    folder.value,
    { seq: 1, name: "start_page" },
    {
      screenshot: true,
      dom: true,
      a11y: true,
    },
  );
  expect(got.ok && got.value.withheld).toBeNull();
  // Why: the owner opens this file by hand (M02 owner check). It is left in place.
  console.log(`Masked capture for the owner check: ${join(t.root, "evidence")}`);
});

test("the NCUA footer link is blocked after a human yes", async () => {
  const o = await look();
  const link = o.elements.find((e) => e.href?.startsWith(NCUA) === true);
  expect(link, "no link to www.ncua.gov on the start page (CONTRACT §10)").toBeDefined();
  if (link === undefined) return;
  await pause();
  expect(await act({ type: "click", target: link.ref })).toMatchObject({
    decision: "allowed",
    rule: "risk.human_approved",
  });
  const blocked = await nextBlock();
  expect(blocked.url.startsWith(NCUA)).toBe(true);
  expect(blocked.rule).toBe("allowlist.host");
  expect(new URL((await look()).url).origin).toBe(BANK);
});

test("a redirect off the list is blocked at its first bad hop", async () => {
  await pause();
  const r = await act({ type: "navigate", to: `${helper.origin}/redirect` });
  expect(r.decision).toBe("allowed");
  const blocked = await nextBlock();
  expect(blocked).toMatchObject({ rule: "allowlist.host" });
  expect(blocked.url.startsWith(NCUA)).toBe(true);
});

test("a page jump to /__test__/faultlog is blocked", async () => {
  await pause();
  const r = await act({ type: "navigate", to: `${helper.origin}/jump` });
  expect(r.decision).toBe("allowed");
  const blocked = await nextBlock();
  expect(blocked).toEqual({
    kind: "network_blocked",
    url: `${BANK}/__test__/faultlog`,
    request: "document",
    rule: "allowlist.path",
  });
  await pause();
});
