// The Playwright marker: draws element ID tags on a masked screenshot in an offline page.
// Follows design section 6 §8.4 and docs/decisions.md (M03, the marker port). The page runs no
// script and loads nothing from the network; the picture arrives as a data address.
import { chromium, type Browser } from "playwright";
import type { Marker, Tag } from "../../ports/marker.js";
import type { Masked } from "../../ports/masked.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { Png } from "../../ports/surface.js";
import { STEP_TIMEOUT_MS } from "./state.js";

/** The width and height in a PNG's header, or null when the bytes are not a PNG. */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 24 || sig.some((b, i) => png[i] !== b)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Escapes text for HTML. Tags are code-made, like `e6`; this keeps that true. */
const html = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The offline page: the picture, and one small label per tag at its box's top left. */
function page(png: Uint8Array, tags: readonly Tag[]): string {
  const src = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  const labels = tags
    .map(
      (t) =>
        `<div class="t" style="left:${String(Math.max(0, Math.round(t.box.x)))}px;` +
        `top:${String(Math.max(0, Math.round(t.box.y)))}px">${html(t.text)}</div>`,
    )
    .join("");
  const style =
    "*{margin:0;padding:0}body{position:relative}img{display:block}" +
    ".t{position:absolute;font:bold 11px/13px monospace;padding:0 2px;color:#000;" +
    "background:#ffd400;border:1px solid #000}";
  return `<!DOCTYPE html><html><head><style>${style}</style></head><body><img src="${src}">${labels}</body></html>`;
}

/** Draws tags with a headless Chromium it starts on first use. */
export class PlaywrightMarker implements Marker {
  #browser: Browser | null = null;

  async mark(png: Masked<Png>, tags: readonly Tag[]): Promise<Outcome<Png, "failed">> {
    const size = pngSize(png);
    if (size === null) return fail("failed", "not a PNG");
    try {
      this.#browser ??= await chromium.launch({ headless: true });
      // Why: no script and no network. Only the data address inside the page loads.
      const context = await this.#browser.newContext({
        viewport: size,
        deviceScaleFactor: 1,
        javaScriptEnabled: false,
        offline: true,
      });
      try {
        const p = await context.newPage();
        await p.route("**/*", (route) => route.abort());
        await p.setContent(page(png, tags), { timeout: STEP_TIMEOUT_MS });
        const out = await p.screenshot({ type: "png", timeout: STEP_TIMEOUT_MS });
        return ok(new Uint8Array(out) as Png);
      } finally {
        await context.close();
      }
    } catch {
      return fail("failed", "the marker page failed");
    }
  }

  async close(): Promise<void> {
    await this.#browser?.close();
    this.#browser = null;
  }
}
