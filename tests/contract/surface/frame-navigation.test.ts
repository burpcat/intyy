// Proves the Playwright adapter reports every document navigation, main or sub-frame, as
// `navigation_started` then `navigation_done`, and never as a `data` request. A frameset keeps
// the top address, so discovery's settle must see a sub-frame load (the real bug, 2026-09-30).
// Runs a real headless browser against a local node:http server on 127.0.0.1; no bank app.
// Design section 7 §5.1 (settle on navigation), section 6 §10.1 step 1.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { playwrightFactory } from "../../../src/adapters/playwright/session.js";
import type { Observation, SurfaceEvent } from "../../../src/ports/surface.js";
import { LEASE, gateConfig, openTestGate, testPolicy, type Opened } from "./gate-kit.js";

const html = (body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;

/** The pages: a top page with a sub-frame, and the pages the links lead to. */
const PAGES: Record<string, string> = {
  "/": html(`<a href="/top2">Go top</a><iframe src="/inner" title="inner" width="300" height="80"></iframe>`),
  "/inner": html(`<a href="/inner2">Go inner</a>`),
  "/inner2": html(`<p>Inner two</p>`),
  "/top2": html(`<p>Top two</p>`),
};

const policy = testPolicy({ allow: Object.keys(PAGES), deny: [], irreversible: [] });

let server: Server;
let origin: string;
let g: Opened | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = PAGES[new URL(req.url ?? "/", "http://127.0.0.1").pathname];
    if (body === undefined) res.writeHead(404).end();
    else res.writeHead(200, { "content-type": "text/html" }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => { r(); })));

afterEach(async () => {
  await g?.gate.close();
  g = null;
});

/** Opens the top page, then observes until the sub-frame's link is on screen. */
async function start(): Promise<{ g: Opened; o: Observation }> {
  g = await openTestGate(playwrightFactory(), gateConfig(origin, policy), policy);
  for (let i = 0; i < 100; i += 1) {
    const o = await g.eyes.observe();
    if (o.ok && o.value.elements.some((e) => e.clues.name === "Go inner")) return { g, o: o.value };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the frameset never loaded");
}

/** Clicks the named link through the gate, and returns every event up to `navigation_done` at `url`. */
async function clickAndCollect(
  { g: open, o }: { g: Opened; o: Observation },
  name: string,
  url: string,
): Promise<SurfaceEvent[]> {
  const events = open.eyes.events()[Symbol.asyncIterator]();
  const link = o.elements.find((e) => e.clues.name === name);
  if (link === undefined) throw new Error(`no link ${name}`);
  const r = await open.gate.act({
    actor: "llm",
    lease: LEASE,
    action: { type: "click", target: link.ref },
    step: null,
    approval: { by: "op_022" },
  });
  if (!r.ok) throw new Error(`act failed: ${r.failure}`);
  const seen: SurfaceEvent[] = [];
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(`no navigation_done for ${url}`)); }, 8000);
  });
  try {
    for (;;) {
      const next = await Promise.race([events.next(), deadline]);
      if (next.done === true) throw new Error("events ended");
      seen.push(next.value);
      if (next.value.kind === "navigation_done" && next.value.url === url) return seen;
    }
  } finally {
    clearTimeout(timer);
  }
}

describe("document navigation events on the real adapter", () => {
  test("a sub-frame navigation emits started then done, and no data request", async () => {
    const url = `${origin}/inner2`;
    const seen = await clickAndCollect(await start(), "Go inner", url);
    const started = seen.findIndex((e) => e.kind === "navigation_started" && e.url === url);
    expect(started).toBeGreaterThanOrEqual(0);
    expect(started).toBeLessThan(seen.length - 1);
    expect(seen.some((e) => e.kind === "request_started" && e.url === url)).toBe(false);
  });

  test("a main-frame navigation still emits started then done", async () => {
    const url = `${origin}/top2`;
    const seen = await clickAndCollect(await start(), "Go top", url);
    const started = seen.findIndex((e) => e.kind === "navigation_started" && e.url === url);
    expect(started).toBeGreaterThanOrEqual(0);
    expect(started).toBeLessThan(seen.length - 1);
    expect(seen.some((e) => e.kind === "request_started" && e.url === url)).toBe(false);
  });
});
