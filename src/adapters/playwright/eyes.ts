// The Playwright eyes: observe the active page and its frames, and take raw captures.
// Follows design section 9 §5.2 (eyes), section 7 §6.1 and §9 (candidates, dialogs, pop-ups),
// section 4 §9.11 (boxes drawn at capture), and section 3 §7.6 (snapshot forms).
import type { Frame, Page } from "playwright";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type {
  ElementRef,
  Eyes,
  Observation,
  Png,
  SurfaceElement,
  SurfaceEvent,
} from "../../ports/surface.js";
import { a11yTree } from "../../core/surface/a11y.js";
import { collectElements, serializeFrame, type RawElement } from "./page-script.js";
import { SECRET_KEY, STEP_TIMEOUT_MS, type BrowserState } from "./state.js";

/** The dialog's elements (section 7 §9.1). An alert has no Dismiss. */
function dialogElements(s: BrowserState, type: string, message: string): SurfaceElement[] {
  const el = (
    part: "box" | "accept" | "dismiss",
    role: string,
    name: string,
    path: string,
  ): SurfaceElement => ({
    ref: s.dialogRef(part),
    ...(part === "box" ? {} : { parent: s.dialogRef("box") }),
    role,
    roleGroup: role === "button" ? "button_like" : "container",
    clues: { name, path },
    enabled: true,
    box: null,
  });
  const out = [
    el("box", "alertdialog", message, "native:dialog"),
    el("accept", "button", "OK", "native:dialog > accept"),
  ];
  if (type !== "alert") out.push(el("dismiss", "button", "Cancel", "native:dialog > dismiss"));
  return out;
}

/** Where a frame sits in top-document pixels. The main frame measures its own scroll. */
async function frameOffset(page: Page, frame: Frame): Promise<{ x: number; y: number }> {
  if (frame === page.mainFrame()) return { x: 0, y: 0 };
  const el = await frame.frameElement();
  const box = await el.boundingBox();
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  return { x: (box?.x ?? 0) + scroll.x, y: (box?.y ?? 0) + scroll.y };
}

/** True when a child frame shows another host. Its content stays unread (section 4 §2.7). */
function foreign(page: Page, frame: Frame): boolean {
  if (frame === page.mainFrame()) return false;
  if (!URL.canParse(frame.url()) || !URL.canParse(page.url())) return true;
  return new URL(frame.url()).origin !== new URL(page.url()).origin;
}

/**
 * Turns one raw element into what the port reports. `frameParent` is the ref of the `iframe`
 * that holds this frame; a frame's top elements sit under it.
 */
function toElement(
  prefix: string,
  raw: RawElement,
  frameParent: string | undefined,
): SurfaceElement {
  // Why a cast: the ElementRef brand has no runtime form.
  const asRef = (r: string): ElementRef => r as unknown as ElementRef;
  const parent = raw.parent ?? frameParent;
  const out: SurfaceElement = {
    ref: asRef(raw.ref),
    ...(parent === undefined ? {} : { parent: asRef(parent) }),
    role: raw.role,
    roleGroup: raw.roleGroup,
    clues: { path: `${prefix}${raw.path}` },
    enabled: raw.enabled,
    box: raw.box,
  };
  if (raw.name !== undefined) out.clues.name = raw.name;
  if (raw.label !== undefined) out.clues.label = raw.label;
  if (raw.text !== undefined) out.clues.text = raw.text;
  if (raw.tooltip !== undefined) out.tooltip = raw.tooltip;
  if (raw.href !== undefined) out.href = raw.href;
  if (raw.field !== undefined) out.field = raw.field;
  if (raw.form !== undefined) out.form = raw.form;
  if (raw.context !== undefined) out.context = raw.context;
  if (raw.unreadable === true) out.unreadable = true;
  return out;
}

/** The eyes over one Playwright session. */
export class PlaywrightEyes implements Eyes {
  constructor(private readonly s: BrowserState) {}

  async observe(): Promise<Outcome<Observation, "page_gone">> {
    const page = this.s.active;
    if (page === null) return fail("page_gone");
    const base = {
      url: page.url(),
      page: this.s.inPopup ? ("popup" as const) : ("main" as const),
      popups: this.s.pages.length - 1,
      viewport: this.s.viewport,
    };
    const d = this.s.dialog;
    // Why: a native box blocks the page's script, and only its elements are candidates (section 7 §9.1).
    if (d !== null) {
      const dialog = { kind: d.type() as "alert" | "confirm" | "prompt", message: d.message() };
      return ok({ ...base, dialog, elements: dialogElements(this.s, d.type(), d.message()) });
    }
    try {
      const elements: SurfaceElement[] = [];
      const popup = this.s.inPopup ? "window[popup] > " : "";
      for (const [fi, frame] of this.s.frames(page).entries()) {
        if (foreign(page, frame)) continue;
        const at = await frameOffset(page, frame);
        const raws = await frame.evaluate(collectElements, {
          tag: this.s.tag(fi),
          offsetX: at.x,
          offsetY: at.y,
          secretKey: SECRET_KEY,
        });
        const prefix = `${popup}${fi === 0 ? "" : `frame[${String(fi - 1)}] > `}`;
        const holder =
          fi === 0
            ? undefined
            : ((await (await frame.frameElement()).getAttribute("data-intyy-ref")) ?? undefined);
        for (const raw of raws) elements.push(toElement(prefix, raw, holder));
      }
      return ok({ ...base, dialog: null, elements });
    } catch {
      return fail("page_gone");
    }
  }

  async screenshot(
    masks: readonly ElementRef[],
  ): Promise<Outcome<Png, "page_gone" | "stale_element">> {
    const page = this.s.active;
    if (page === null) return fail("page_gone");
    const locators = [];
    for (const m of masks) {
      const t = await this.s.resolve(m);
      // Why: section 4 §9.11 fail closed. A box that cannot be found means no picture.
      if (t?.kind !== "element") return fail("stale_element");
      locators.push(t.locator);
    }
    try {
      const bytes = await page.screenshot({
        type: "png",
        mask: locators,
        maskColor: "#000000",
        animations: "disabled",
        caret: "hide",
        timeout: STEP_TIMEOUT_MS,
      });
      return ok(new Uint8Array(bytes) as Png);
    } catch {
      return fail("page_gone");
    }
  }

  async snapshots(): Promise<Outcome<{ dom: string; a11y: string }, "page_gone">> {
    const page = this.s.active;
    if (page === null) return fail("page_gone");
    const d = this.s.dialog;
    if (d !== null) {
      return ok({ dom: "", a11y: a11yTree(dialogElements(this.s, d.type(), d.message())) });
    }
    try {
      // Why: section 3 §7.6, frames are saved in order, in one file.
      const parts: string[] = [];
      for (const [fi, frame] of this.s.frames(page).entries()) {
        if (foreign(page, frame)) continue;
        const html = await frame.evaluate(serializeFrame);
        parts.push(fi === 0 ? html : `<!-- frame[${String(fi - 1)}] -->\n${html}`);
      }
      const seen = await this.observe();
      if (!seen.ok) return seen;
      return ok({ dom: parts.join("\n"), a11y: a11yTree(seen.value.elements) });
    } catch {
      return fail("page_gone");
    }
  }

  async crop(el: ElementRef): Promise<Outcome<Png, "stale_element">> {
    const t = await this.s.resolve(el);
    if (t?.kind !== "element") return fail("stale_element");
    try {
      const bytes = await t.locator.screenshot({ type: "png", timeout: STEP_TIMEOUT_MS });
      return ok(new Uint8Array(bytes) as Png);
    } catch {
      return fail("stale_element");
    }
  }

  events(signal?: AbortSignal): AsyncIterable<SurfaceEvent> {
    return this.s.hub.subscribe(signal);
  }
}
