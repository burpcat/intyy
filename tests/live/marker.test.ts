// Proves the Playwright marker draws tags offline: same size, the tag's pixels change, and the
// rest stays. It never touches the bank app. Design section 6 §8.4; M03 task 3.
import { chromium } from "playwright";
import { afterAll, describe, expect, test } from "vitest";
import { PlaywrightMarker, pngSize } from "../../src/adapters/playwright/marker.js";
import type { Masked } from "../../src/ports/masked.js";
import type { Png } from "../../src/ports/surface.js";

const marker = new PlaywrightMarker();
const browser = await chromium.launch({ headless: true });
afterAll(async () => {
  await marker.close();
  await browser.close();
});

/** A plain white picture, 300 by 200. */
async function white(): Promise<Uint8Array> {
  const p = await browser.newPage({ viewport: { width: 300, height: 200 } });
  await p.setContent("<body style='margin:0;background:#fff'></body>");
  const png = new Uint8Array(await p.screenshot({ type: "png" }));
  await p.close();
  return png;
}

/** The colour of one pixel, read back through a canvas. */
async function pixel(png: Uint8Array, x: number, y: number): Promise<number[]> {
  const p = await browser.newPage();
  const src = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  const rgba = await p.evaluate(
    async ([s, px, py]) => {
      const img = new Image();
      img.src = s;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      if (g === null) return [];
      g.drawImage(img, 0, 0);
      return [...g.getImageData(px, py, 1, 1).data];
    },
    [src, x, y] as const,
  );
  await p.close();
  return rgba;
}

describe("playwright marker", () => {
  test("draws a tag at the box's top left and keeps the picture's size", async () => {
    const base = await white();
    const out = await marker.mark(base as Masked<Png>, [
      { text: "e6", box: { x: 40, y: 30, width: 80, height: 20 } },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(pngSize(out.value)).toEqual({ width: 300, height: 200 });
    expect(await pixel(out.value, 45, 36)).not.toEqual([255, 255, 255, 255]);
    expect(await pixel(out.value, 250, 150)).toEqual([255, 255, 255, 255]);
  });

  test("bytes that are not a PNG fail without a browser call", async () => {
    const out = await marker.mark(new Uint8Array([1, 2, 3]) as Masked<Png>, []);
    expect(out).toMatchObject({ ok: false, failure: "failed" });
  });
});
