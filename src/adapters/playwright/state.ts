// The live browser state that the eyes and hands share: pages, the open dialog, and refs.
// Follows design section 9 §5.2 (refs valid until the next page change) and section 7 §9.
import type { Dialog, Frame, Locator, Page } from "playwright";
import type { EventHub } from "../../core/events/hub.js";
import type { ElementRef, SurfaceEvent, Viewport } from "../../ports/surface.js";

/** A window key under which the page keeps the set of secret-filled fields. */
export const SECRET_KEY = "__intyySecretFields";

/** How long one browser step may take. ponytail: one fixed value; section 7 §5.4 tunes timeouts in M05. */
export const STEP_TIMEOUT_MS = 15_000;

/** What a ref points at: a page element in one frame, or a part of the open native dialog. */
export type RefTarget =
  | { kind: "element"; frame: Frame; locator: Locator }
  | { kind: "dialog"; part: "box" | "accept" | "dismiss" };

/** The session's live state. `generation` changes on every page change, so old refs go stale. */
export class BrowserState {
  /** Open windows, oldest first. The last one is active (section 7 §9.2). */
  readonly pages: Page[] = [];
  dialog: Dialog | null = null;
  generation = 0;
  closed = false;

  constructor(
    readonly hub: EventHub<SurfaceEvent>,
    readonly viewport: Viewport,
  ) {}

  /** The active page, or null when every window is gone. */
  get active(): Page | null {
    const page = this.pages.at(-1);
    return this.closed || page === undefined || page.isClosed() ? null : page;
  }

  /** True when the active page is a pop-up. */
  get inPopup(): boolean {
    return this.pages.length > 1;
  }

  /** Marks a page change: every old ref goes stale. */
  changed(): void {
    this.generation += 1;
    this.hub.emit({ kind: "page_changed" });
  }

  /** The frames the eyes read: the main frame first, then child frames in order. */
  frames(page: Page): Frame[] {
    return page.frames();
  }

  /** The tag written on elements of one frame, like `4:f1`. Frame 0 is the main frame. */
  tag(frameIndex: number): string {
    return `${String(this.generation)}:f${String(frameIndex)}`;
  }

  /** Makes a ref for element `idx` in frame `frameIndex`. */
  ref(frameIndex: number, idx: number): ElementRef {
    // Why a cast: the ElementRef brand has no runtime form.
    return `${this.tag(frameIndex)}:${String(idx)}` as unknown as ElementRef;
  }

  /** Makes a ref for a part of the open native dialog. */
  dialogRef(part: "box" | "accept" | "dismiss"): ElementRef {
    return `${String(this.generation)}:native:${part}` as unknown as ElementRef;
  }

  /** Finds what a ref points at. Null when the ref is stale or the element is gone. */
  async resolve(ref: ElementRef): Promise<RefTarget | null> {
    const text = ref as unknown as string;
    const [gen, where, rest] = text.split(":");
    if (gen !== String(this.generation) || where === undefined || rest === undefined) return null;
    if (where === "native") {
      if (this.dialog === null) return null;
      if (rest === "box" || rest === "accept" || rest === "dismiss")
        return { kind: "dialog", part: rest };
      return null;
    }
    const page = this.active;
    if (page === null || this.dialog !== null) return null;
    const frame = this.frames(page)[Number(where.slice(1))];
    if (frame === undefined) return null;
    const locator = frame.locator(`[data-intyy-ref="${text}"]`);
    try {
      return (await locator.count()) === 1 ? { kind: "element", frame, locator } : null;
    } catch {
      return null;
    }
  }
}
