// The surface contract: the snapshot fake and the Playwright adapter behave the same.
// This half needs no action. Tests that act go through the gate (M02 task 7; owner decision).
// Design section 9 §5.2, §5.9, §16 ("Port contract suites"); section 7 §9; section 2 §13.2.
import { afterEach, describe, expect, test } from "vitest";
import { buildAllowlist } from "../../../src/core/safety/policy/allowlist.js";
import type { SurfaceSession } from "../../../src/ports/hands.js";
import type { ElementRef, Eyes, Observation, SessionConfig } from "../../../src/ports/surface.js";
import { SITE_PATHS } from "./site.js";

/** A backend under test: a session over the fixture site at `origin`. */
export type SurfaceBackend = { session: SurfaceSession; origin: string };

/** The PNG file signature. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A ref no backend ever made. */
const BOGUS = "bogus" as unknown as ElementRef;

/** The session settings every test uses. */
export function sessionConfig(origin: string): SessionConfig {
  return {
    origin,
    allowlist: buildAllowlist({
      origin,
      extraOrigins: [],
      paths: SITE_PATHS,
      browser: { popups: "allowlist" },
    }),
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timeZone: "America/New_York",
    visible: false,
  };
}

/** Finds one element by a clue, or fails the test. */
function find(
  o: Observation,
  clue: "name" | "label",
  value: string,
): Observation["elements"][number] {
  const el = o.elements.find((e) => e.clues[clue] === value);
  if (el === undefined) throw new Error(`no element with ${clue} ${value}`);
  return el;
}

/** Runs the surface contract against one backend. */
export function surfaceContract(name: string, make: () => Promise<SurfaceBackend>): void {
  describe(`surface contract: ${name}`, () => {
    let open: SurfaceSession | null = null;

    afterEach(async () => {
      await open?.close();
      open = null;
    });

    /** Opens a session and observes the start page. */
    async function start(): Promise<{ eyes: Eyes; o: Observation; origin: string }> {
      const b = await make();
      open = b.session;
      const opened = await b.session.open(sessionConfig(b.origin));
      if (!opened.ok) throw new Error(`open failed: ${opened.failure}`);
      const o = await opened.value.eyes.observe();
      if (!o.ok) throw new Error(`observe failed: ${o.failure}`);
      return { eyes: opened.value.eyes, o: o.value, origin: b.origin };
    }

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
      open = b.session;
      const opened = await b.session.open(sessionConfig("http://127.0.0.1:9"));
      expect(opened).toMatchObject({ ok: false, failure: "unreachable" });
    });

    test("a button has its role, role group, name, path, and box", async () => {
      const { o } = await start();
      const search = find(o, "name", "Search");
      expect(search.role).toBe("button");
      expect(search.roleGroup).toBe("button_like");
      expect(search.enabled).toBe(true);
      expect(search.clues.path).not.toBe("");
      expect(search.box?.width).toBeGreaterThan(0);
      expect(search.box?.height).toBeGreaterThan(0);
      expect(search.form).toEqual({ id: expect.any(String) as string, submits: true });
    });

    test("a text box has its label and an empty value", async () => {
      const { o } = await start();
      const box = find(o, "label", "Member ID");
      expect(box.roleGroup).toBe("text_entry");
      expect(box.field).toEqual({ kind: "text", value: "" });
    });

    test("a password box says so", async () => {
      const { o } = await start();
      expect(find(o, "label", "Password").field?.kind).toBe("password");
    });

    test("a plain link is navigation with its full address", async () => {
      const { o, origin } = await start();
      const link = find(o, "name", "Members");
      expect(link.roleGroup).toBe("navigation");
      expect(link.href).toBe(`${origin}/members`);
      expect(find(o, "name", "NCUA").href).toBe("https://www.ncua.gov/");
    });

    test("elements inside a frame name the frame in their path", async () => {
      const { o } = await start();
      expect(find(o, "name", "Help").clues.path).toMatch(/frame\[0\]/);
    });

    test("what the redactor cannot read is marked", async () => {
      const { o } = await start();
      expect(o.elements.some((e) => e.unreadable === true)).toBe(true);
    });

    test("a screenshot is a PNG; a stale mask fails the whole shot", async () => {
      const { eyes, o } = await start();
      const shot = await eyes.screenshot([find(o, "name", "Search").ref]);
      expect(shot.ok && [...shot.value.slice(0, 8)]).toEqual(PNG);
      expect(await eyes.screenshot([BOGUS])).toMatchObject({ ok: false, failure: "stale_element" });
    });

    test("a crop is a PNG; a stale ref fails", async () => {
      const { eyes, o } = await start();
      const crop = await eyes.crop(find(o, "name", "Search").ref);
      expect(crop.ok && [...crop.value.slice(0, 8)]).toEqual(PNG);
      expect(await eyes.crop(BOGUS)).toMatchObject({ ok: false, failure: "stale_element" });
    });

    test("snapshots hold the page text", async () => {
      const { eyes } = await start();
      const s = await eyes.snapshots();
      expect(s.ok && s.value.dom).toContain("Search");
      expect(s.ok && s.value.a11y).toContain("Search");
    });

    test("after close the page is gone and events end", async () => {
      const { eyes } = await start();
      const events = eyes.events();
      await open?.close();
      open = null;
      expect(await eyes.observe()).toMatchObject({ ok: false, failure: "page_gone" });
      const seen = [];
      for await (const e of events) seen.push(e);
      expect(seen).toEqual([]);
    });
  });
}
