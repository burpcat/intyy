// Proves the Playwright adapter's human-input capture: `toHumanInput` accepts only well-formed
// page reports; a password field reports no value; Enter in a form field is one `press` with the
// form's submit control (no second click); and the input a bot's own actions make falls inside the
// bot's window, while the typed secret is in no event. Runs a real headless browser against a
// local node:http server on 127.0.0.1; no bank app. Design section 7 §14.1 to §14.3; section 4
// §8.6, §8.10. M07 task 3.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { CAPTURE_BINDING, captureInitScript, toHumanInput } from "../../../src/adapters/playwright/capture.js";
import { playwrightFactory } from "../../../src/adapters/playwright/session.js";
import { BotWindows } from "../../../src/core/handoff/capture.js";
import { openGate } from "../../../src/core/safety/gate/gate.js";
import type { ElementRef, HumanInput, SurfaceEvent } from "../../../src/ports/surface.js";
import { DISCOVERY, LEASE, TEST_PASSWORD, gateConfig, testDeps, testPolicy, testSecrets } from "./gate-kit.js";

const html = (body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;

const PAGE = html(`
  <form onsubmit="return false">
    <label for="note">Note</label><input id="note" name="note" type="text">
    <label for="pw">Password</label><input id="pw" name="pw" type="password">
    <button type="submit">Send</button>
  </form>
  <button type="button" id="other">Other</button>
`);

const policy = testPolicy({ allow: ["/"], deny: [], irreversible: [] });

let server: Server;
let origin: string;
const closers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/") res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => { r(); })));
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

/** A gate on the real adapter, the bot's windows, and every human_input event the page reports. */
async function open() {
  const windows = new BotWindows(() => Date.now());
  const opened = await openGate(playwrightFactory(), gateConfig(origin, policy), {
    ...testDeps(policy, DISCOVERY, [], testSecrets(policy)),
    botAction: windows,
  });
  if (!opened.ok) throw new Error(`open failed: ${opened.failure}`);
  const { eyes, gate } = opened.value;
  closers.push(() => gate.close());
  const seen: SurfaceEvent[] = [];
  void (async () => {
    for await (const e of eyes.events()) seen.push(e);
  })();
  const refOf = async (label: string): Promise<ElementRef> => {
    for (let i = 0; i < 100; i += 1) {
      const o = await eyes.observe();
      const el = o.ok ? o.value.elements.find((e) => e.clues.name === label || e.clues.label === label) : undefined;
      if (el !== undefined) return el.ref;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no element ${label}`);
  };
  const act = async (action: Parameters<typeof gate.act>[0]["action"]): Promise<void> => {
    const r = await gate.act({ actor: "llm", lease: LEASE, action, step: null, approval: { by: "op_022" } });
    if (!r.ok || r.value.decision === "blocked") throw new Error(`act did not pass: ${r.ok ? r.value.rule : r.failure}`);
  };
  const inputs = (): HumanInput[] =>
    seen.flatMap((e) => (e.kind === "human_input" && e.input !== undefined ? [e.input] : []));
  const settle = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms));
  return { windows, refOf, act, inputs, seen, settle };
}

const pathOf = (i: HumanInput): string | null =>
  i.action.type === "navigate" ? null : i.action.type === "press" ? (i.action.target?.clues.path ?? null) : i.action.target.clues.path;

describe("toHumanInput: the page is untrusted", () => {
  const print = { role: "textbox", roleGroup: "text_entry", clues: { label: "Note", path: "form > input" }, box: null };

  test("toHumanInput accepts well-formed reports, refuses bad ones, and the init script installs the capture", () => {
    // a well-formed report becomes an input, with the frame prefix on its path
    const got = toHumanInput({ kind: "type", at: 5, url: "http://127.0.0.1/", target: print, value: "hello" }, "frame[0] > ");
    expect(got).toMatchObject({ at: 5, action: { type: "type", value: "hello", target: { clues: { path: "frame[0] > form > input" } } } });

    // a password report carries a null value through
    const pw = toHumanInput({ kind: "type", at: 5, url: "u", target: { ...print, fieldKind: "password" }, value: null }, "");
    expect(pw).toMatchObject({ action: { type: "type", value: null, target: { fieldKind: "password" } } });

    // each bad report is refused (null), so the engine counts a bare touch
    const refused: [string, unknown][] = [
      ["not an object", 7],
      ["an unknown kind", { kind: "drag", at: 1, url: "u", target: print }],
      ["a missing time", { kind: "click", url: "u", target: print }],
      ["a missing target", { kind: "click", at: 1, url: "u" }],
      ["an unknown role group", { kind: "click", at: 1, url: "u", target: { ...print, roleGroup: "weird" } }],
      ["a number for a typed value", { kind: "type", at: 1, url: "u", target: print, value: 7 }],
    ];
    for (const [name, raw] of refused) expect(toHumanInput(raw, ""), name).toBeNull();

    // the init script names the binding and installs the capture
    const script = captureInitScript("__secretKey");
    expect(script).toContain(CAPTURE_BINDING);
    expect(script).toContain("__secretKey");
  });
});

describe("the real page script (section 7 §14.1, §14.2)", () => {
  test("a bot's click is reported, and it falls inside the bot's window", async () => {
    const o = await open();
    await o.act({ type: "click", target: await o.refOf("Other") });
    await o.settle();
    const clicks = o.inputs().filter((i) => i.action.type === "click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.action).toMatchObject({ type: "click", target: { clues: { name: "Other" } } });
    for (const i of o.inputs()) expect(o.windows.owns(i.at, pathOf(i)), `${i.action.type} is the bot's`).toBe(true);
  });

  test("a password field reports no value, and the secret is in no event", async () => {
    const o = await open();
    await o.act({ type: "type", target: await o.refOf("Password"), value: { kind: "secret", name: "operator_password" } });
    await o.act({ type: "click", target: await o.refOf("Other") }); // moves the focus: the field's blur reports
    await o.settle();
    const typed = o.inputs().filter((i) => i.action.type === "type");
    expect(typed).toHaveLength(1);
    expect(typed[0]?.action).toMatchObject({ value: null, target: { fieldKind: "password" } });
    expect(JSON.stringify(o.seen)).not.toContain(TEST_PASSWORD);
    for (const i of o.inputs()) expect(o.windows.owns(i.at, pathOf(i))).toBe(true);
  });

  test("a bot's fill into a text field is reported once, with its text, inside the bot's window", async () => {
    const o = await open();
    await o.act({ type: "type", target: await o.refOf("Note"), value: { kind: "text", text: "hello there" } });
    await o.act({ type: "click", target: await o.refOf("Other") });
    await o.settle();
    const typed = o.inputs().filter((i) => i.action.type === "type");
    expect(typed).toHaveLength(1);
    for (const t of typed) expect(t.action).toMatchObject({ value: "hello there", target: { fieldKind: "text" } });
    // Whatever the page reported, every report belongs to the bot's windows.
    for (const i of o.inputs()) expect(o.windows.owns(i.at, pathOf(i)), `${i.action.type} is the bot's`).toBe(true);
  });

  test("Enter in a form field is one press with the submit control, and no second click", async () => {
    const o = await open();
    const note = await o.refOf("Note");
    await o.act({ type: "type", target: note, value: { kind: "text", text: "go" } });
    await o.act({ type: "press", key: "Enter", target: note });
    await o.settle(600);
    const presses = o.inputs().filter((i) => i.action.type === "press" && i.action.key === "Enter");
    expect(presses).toHaveLength(1);
    expect(presses[0]?.action).toMatchObject({ type: "press", key: "Enter", submit: { clues: { name: "Send" } } });
    expect(o.inputs().filter((i) => i.action.type === "click")).toHaveLength(0);
  });
});
