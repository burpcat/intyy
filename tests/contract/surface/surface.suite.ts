// The surface contract: the snapshot fake and the Playwright adapter behave the same.
// Every session opens behind the gate, and every action goes through it (owner decision, M02).
// Design section 9 §5.2, §5.9, §16 ("Port contract suites"); section 7 §9; section 2 §13.2.
import { afterEach, describe, expect, test } from "vitest";
import { openGate, type GateAction, type GateResult } from "../../../src/core/safety/gate/gate.js";
import type {
  ElementRef,
  Eyes,
  Observation,
  SurfaceElement,
  SurfaceEvent,
  SurfaceFactory,
} from "../../../src/ports/surface.js";
import {
  DISCOVERY,
  LEASE,
  TEST_PASSWORD,
  gateConfig,
  openTestGate,
  testDeps,
  testPolicy,
  type Opened,
} from "./gate-kit.js";
import {
  boxedElements,
  maskedCrop,
  maskedScreenshot,
} from "../../../src/core/safety/redaction/images.js";
import { Redactor, redactionRules } from "../../../src/core/safety/redaction/redactor.js";
import { SITE_PATHS } from "./site.js";

/** A backend under test: a fresh unopened surface over the fixture site at `origin`. */
export type SurfaceBackend = { factory: () => SurfaceFactory; origin: string };

/** The PNG file signature. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A ref no backend ever made. */
const BOGUS = "bogus" as unknown as ElementRef;

const policy = testPolicy(SITE_PATHS);

/** Finds one element by name or label, or fails the test. */
function find(o: Observation, value: string): SurfaceElement {
  const el = o.elements.find((e) => e.clues.name === value || e.clues.label === value);
  if (el === undefined) throw new Error(`no element named ${value}`);
  return el;
}

/** Observes, or fails the test. */
async function look(eyes: Eyes): Promise<Observation> {
  const o = await eyes.observe();
  if (!o.ok) throw new Error(`observe failed: ${o.failure}`);
  return o.value;
}

/** Observes until `ok` holds. The live browser settles in its own time; the fake at once. */
async function until(eyes: Eyes, ok: (o: Observation) => boolean): Promise<Observation> {
  for (let i = 0; i < 100; i += 1) {
    const o = await eyes.observe();
    if (o.ok && ok(o.value)) return o.value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the screen never reached the expected state");
}

/** Reads events until one of `kind` arrives, or fails after five seconds. */
async function waitEvent(
  events: AsyncIterator<SurfaceEvent>,
  kind: SurfaceEvent["kind"],
): Promise<SurfaceEvent> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no ${kind} event`));
    }, 5000);
  });
  try {
    for (;;) {
      const next = await Promise.race([events.next(), deadline]);
      if (next.done === true) throw new Error(`events ended before ${kind}`);
      if (next.value.kind === kind) return next.value;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the surface contract against one backend. */
export function surfaceContract(name: string, make: () => Promise<SurfaceBackend>): void {
  describe(`surface contract: ${name}`, () => {
    let open: Opened | null = null;

    afterEach(async () => {
      await open?.gate.close();
      open = null;
    });

    /** Opens a gated session and observes the start page. */
    async function start(): Promise<Opened & { o: Observation; origin: string }> {
      const b = await make();
      open = await openTestGate(b.factory(), gateConfig(b.origin, policy), policy);
      return { ...open, o: await look(open.eyes), origin: b.origin };
    }

    /** Proposes one discovery action as the LLM. `approved` stands for a human yes. */
    async function act(g: Opened, action: GateAction, approved = false): Promise<GateResult> {
      const r = await g.gate.act({
        actor: "llm",
        lease: LEASE,
        action,
        step: null,
        ...(approved ? { approval: { by: "op_022" } } : {}),
      });
      if (!r.ok) throw new Error(`act failed: ${r.failure}`);
      return r.value;
    }

    describe("eyes", () => {
      test("open loads the start page through the guard", async () => {
        const { o, origin } = await start();
        expect(o.url).toBe(`${origin}/`);
        expect(o.page).toBe("main");
        expect(o.popups).toBe(0);
        expect(o.dialog).toBeNull();
        expect(o.viewport).toEqual({ width: 1280, height: 800 });
      });

      test("an origin that does not answer is unreachable", async () => {
        const b = await make();
        const cfg = gateConfig("http://127.0.0.1:9", policy);
        const opened = await openGate(b.factory(), cfg, testDeps(policy, DISCOVERY, []));
        expect(opened).toMatchObject({ ok: false, failure: "unreachable" });
      });

      test("a button has its role, role group, name, path, box, and form", async () => {
        const { o } = await start();
        const search = find(o, "Search");
        expect(search.role).toBe("button");
        expect(search.roleGroup).toBe("button_like");
        expect(search.enabled).toBe(true);
        expect(search.clues.path).not.toBe("");
        expect(search.box?.width).toBeGreaterThan(0);
        expect(search.box?.height).toBeGreaterThan(0);
        expect(search.form).toEqual({ id: expect.any(String) as string, submits: true });
      });

      test("fields have their labels and state", async () => {
        const { o } = await start();
        expect(find(o, "Member ID")).toMatchObject({
          roleGroup: "text_entry",
          field: { kind: "text", value: "" },
        });
        expect(find(o, "Password").field?.kind).toBe("password");
        expect(find(o, "Joint")).toMatchObject({
          roleGroup: "check",
          field: { kind: "check", checked: false },
        });
        expect(find(o, "Kind")).toMatchObject({
          roleGroup: "choice",
          field: { kind: "choice", value: "Savings" },
        });
      });

      test("a plain link is navigation with its full address", async () => {
        const { o, origin } = await start();
        const link = find(o, "Members");
        expect(link.roleGroup).toBe("navigation");
        expect(link.href).toBe(`${origin}/members`);
        expect(find(o, "NCUA").href).toBe("https://www.ncua.gov/");
      });

      test("elements inside a frame name the frame in their path", async () => {
        const { o } = await start();
        expect(find(o, "Help").clues.path).toMatch(/frame\[0\]/);
      });

      test("what the redactor cannot read is marked", async () => {
        const { o } = await start();
        expect(o.elements.some((e) => e.unreadable === true)).toBe(true);
      });

      test("a screenshot is a PNG; a stale mask fails the whole shot", async () => {
        const { eyes, o } = await start();
        const shot = await eyes.screenshot([find(o, "Search").ref]);
        expect(shot.ok && [...shot.value.slice(0, 8)]).toEqual(PNG);
        expect(await eyes.screenshot([BOGUS])).toMatchObject({
          ok: false,
          failure: "stale_element",
        });
      });

      test("a crop is a PNG; a stale ref fails", async () => {
        const { eyes, o } = await start();
        const crop = await eyes.crop(find(o, "Search").ref);
        expect(crop.ok && [...crop.value.slice(0, 8)]).toEqual(PNG);
        expect(await eyes.crop(BOGUS)).toMatchObject({ ok: false, failure: "stale_element" });
      });

      test("snapshots hold the page text", async () => {
        const { eyes } = await start();
        const s = await eyes.snapshots();
        expect(s.ok && s.value.dom).toContain("Search");
        expect(s.ok && s.value.a11y).toContain("Search");
      });

      test("each element names its parent: form, frame, and dialog", async () => {
        const { o } = await start();
        const form = o.elements.find((e) => e.role === "form");
        expect(find(o, "Search").parent).toBe(form?.ref);
        expect(find(o, "Member ID").parent).toBe(form?.ref);
        expect(find(o, "Help").parent).toBe(find(o, "help").ref);
        expect(find(o, "Members").parent).toBeUndefined();
      });

      test("the accessibility snapshot is a nested tree with no values", async () => {
        const g = await start();
        await act(g, {
          type: "type",
          target: find(g.o, "Member ID").ref,
          value: { kind: "text", text: "100107" },
        });
        const s = await g.eyes.snapshots();
        const a11y = s.ok ? s.value.a11y : "";
        // Why: docs/formats/a11y-snapshot.md, children sit two spaces under their parent.
        expect(a11y).toContain(
          [
            '- form "Member ID Password Search":',
            '  - textbox "Member ID"',
            '  - textbox "Password"',
            '  - button "Search"',
            '- link "Members":',
            `  - /url: ${g.origin}/members`,
          ].join("\n"),
        );
        expect(a11y).toContain(['- iframe "help":', '  - button "Help"'].join("\n"));
        expect(a11y).not.toContain("100107");
      });

      test("request events carry a static or data resource kind", async () => {
        const g = await start();
        const events = g.eyes.events()[Symbol.asyncIterator]();
        await act(g, { type: "click", target: find(g.o, "Members").ref });
        const seen: string[] = [];
        for (let i = 0; i < 2; i += 1) {
          const e = await waitEvent(events, "request_started");
          seen.push(e.kind === "request_started" ? e.resource : "?");
        }
        expect(seen.sort()).toEqual(["data", "static"]);
      });

      test("after close the page is gone and events end", async () => {
        const g = await start();
        const events = g.eyes.events();
        await g.gate.close();
        open = null;
        expect(await g.eyes.observe()).toMatchObject({ ok: false, failure: "page_gone" });
        const seen = [];
        for await (const e of events) seen.push(e);
        expect(seen).toEqual([]);
      });
    });

    describe("hands, through the gate", () => {
      test("typing shows the value", async () => {
        const g = await start();
        const r = await act(g, {
          type: "type",
          target: find(g.o, "Member ID").ref,
          value: { kind: "text", text: "100107" },
        });
        expect(r).toMatchObject({ decision: "allowed", act: { dispatched: true } });
        expect(find(await look(g.eyes), "Member ID").field?.value).toBe("100107");
        // Why: raw snapshots hold no field values (section 3 §7.6).
        const snaps = await g.eyes.snapshots();
        expect(snaps.ok && snaps.value.dom + snaps.value.a11y).not.toContain("100107");
      });

      test("a secret fills a password box and reads back only as filled", async () => {
        const g = await start();
        const r = await act(g, {
          type: "type",
          target: find(g.o, "Password").ref,
          value: { kind: "secret", name: "operator_password" },
        });
        expect(r).toMatchObject({ decision: "allowed", act: { dispatched: true } });
        const o = await look(g.eyes);
        expect(find(o, "Password").field).toEqual({ kind: "password", filled: true });
        const snaps = await g.eyes.snapshots();
        // Why: section 4 §8.6, a secret-filled field is never read back into intyy.
        expect(JSON.stringify([o, snaps, g.lines])).not.toContain(TEST_PASSWORD);
      });

      test("a masked screenshot boxes a filled field; a button crop is kept", async () => {
        const g = await start();
        await act(g, {
          type: "type",
          target: find(g.o, "Member ID").ref,
          value: { kind: "text", text: "100107" },
        });
        const r = new Redactor(redactionRules(policy));
        const o = await look(g.eyes);
        expect(boxedElements(o, r).map((e) => e.clues.label)).toContain("Member ID");
        const shot = await maskedScreenshot(g.eyes, r);
        expect(shot.ok && [...shot.value.slice(0, 8)]).toEqual(PNG);
        const crop = await maskedCrop(g.eyes, o, find(o, "Search").ref, r);
        expect(crop.ok).toBe(true);
      });

      test("a checkbox and a select change state", async () => {
        const g = await start();
        await act(g, { type: "set_checked", target: find(g.o, "Joint").ref, checked: true });
        await act(g, { type: "select", target: find(g.o, "Kind").ref, option: "Checking" });
        const o = await look(g.eyes);
        expect(find(o, "Joint").field?.checked).toBe(true);
        expect(find(o, "Kind").field?.value).toBe("Checking");
        const s = await g.eyes.snapshots();
        expect(s.ok && s.value.a11y).toContain('- checkbox "Joint" [checked]');
      });

      test("a ref stays on its element when a script adds another element", async () => {
        const g = await start();
        const search = find(g.o, "Search").ref;
        await act(g, { type: "click", target: find(g.o, "Add note").ref });
        const o = await until(g.eyes, (x) => x.elements.some((e) => e.clues.text === "Note added"));
        // Why: a position-based ref would now point one element off (decisions.md, M02).
        expect(find(o, "Search").ref).toBe(search);
        expect((await act(g, { type: "click", target: search })).decision).toBe("allowed");
        await until(g.eyes, (x) => x.url === `${g.origin}/members`);
      });

      test("a link changes the page; old refs go stale", async () => {
        const g = await start();
        const events = g.eyes.events()[Symbol.asyncIterator]();
        const old = find(g.o, "Members").ref;
        await act(g, { type: "click", target: old });
        await waitEvent(events, "page_changed");
        const o = await until(g.eyes, (x) => x.url === `${g.origin}/members`);
        expect(o.elements.some((e) => e.clues.text === "Members")).toBe(true);
        const again = await g.gate.act({
          actor: "llm",
          lease: LEASE,
          action: { type: "click", target: old },
          step: null,
        });
        expect(again).toMatchObject({ ok: false, failure: "stale_element" });
      });

      test("Enter in a field submits its form", async () => {
        const g = await start();
        const target = find(g.o, "Member ID").ref;
        const r = await act(g, { type: "press", key: "Enter", target });
        expect(r.decision).toBe("allowed");
        await until(g.eyes, (x) => x.url === `${g.origin}/members`);
      });

      test("a native confirm box shows as elements, and only its elements", async () => {
        const g = await start();
        const pending = await act(g, { type: "click", target: find(g.o, "Delete").ref });
        expect(pending).toMatchObject({ decision: "needs_approval", rule: "risk.needs_approval" });
        await act(g, { type: "click", target: find(g.o, "Delete").ref }, true);
        const o = await until(g.eyes, (x) => x.dialog !== null);
        expect(o.dialog).toEqual({ kind: "confirm", message: "Delete member?" });
        expect(o.elements.map((e) => [e.role, e.clues.name, e.clues.path])).toEqual([
          ["alertdialog", "Delete member?", "native:dialog"],
          ["button", "OK", "native:dialog > accept"],
          ["button", "Cancel", "native:dialog > dismiss"],
        ]);
        const box = o.elements[0]?.ref;
        expect(o.elements.slice(1).map((e) => e.parent)).toEqual([box, box]);
        // Why: "Cancel" is a bland label, so dismissing is unsure too (section 4 §7.3).
        const cancel = find(o, "Cancel").ref;
        expect(await act(g, { type: "click", target: cancel })).toMatchObject({
          rule: "risk.unsure",
        });
        await act(g, { type: "click", target: cancel }, true);
        expect((await until(g.eyes, (x) => x.dialog === null)).url).toBe(`${g.origin}/`);
      });

      test("a pop-up becomes the active page, and closing it returns to the opener", async () => {
        const g = await start();
        await act(g, { type: "click", target: find(g.o, "Lookup").ref });
        const popup = await until(g.eyes, (x) => x.page === "popup" && x.elements.length > 0);
        expect(popup.popups).toBe(1);
        expect(popup.url).toBe(`${g.origin}/lookup`);
        const close = find(popup, "Close");
        expect(close.clues.path.startsWith("window[popup]")).toBe(true);
        await act(g, { type: "click", target: close.ref });
        const back = await until(g.eyes, (x) => x.page === "main");
        expect(back.popups).toBe(0);
      });

      test("a covered click's readiness check fails first: it stays dispatched: false", async () => {
        // Why: section 7 §7.2, "a pop-up covered Confirm". A short readiness timeout keeps this
        // fast on the live backend, whose click really waits out the cap before giving up.
        const g = await start();
        const r = await act(
          g,
          { type: "click", target: find(g.o, "Covered").ref, readinessTimeoutMs: 200 },
          true,
        );
        expect(r).toMatchObject({ decision: "allowed", act: { dispatched: false } });
      });

      test("the guard blocks a link off the allowlist, even after a human yes", async () => {
        const g = await start();
        const events = g.eyes.events()[Symbol.asyncIterator]();
        const ncua = find(g.o, "NCUA").ref;
        // Why: a link off the list is button-like, so its bland label is unsure (decisions.md, M02).
        expect(await act(g, { type: "click", target: ncua })).toMatchObject({
          rule: "risk.unsure",
        });
        await act(g, { type: "click", target: ncua }, true);
        expect(await waitEvent(events, "network_blocked")).toEqual({
          kind: "network_blocked",
          url: "https://www.ncua.gov/",
          request: "document",
          rule: "allowlist.host",
        });
        expect((await look(g.eyes)).url).toBe(`${g.origin}/`);
      });
    });
  });
}
