// Proves the snapshot fake's `crop` (design section 7 §6.3, `image`; M08 decision on the fake):
// an element with `image` returns exactly those PNG bytes, one without keeps the old fake
// image, and a stale ref is stale_element.
import { describe, expect, test } from "vitest";
import { decodePng } from "../../../src/core/targets/png.js";
import { encodePng } from "../../../src/fakes/png.js";
import { SnapshotSurface, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import type { ElementRef } from "../../../src/ports/surface.js";

const ORIGIN = "http://127.0.0.1:9281";
const PICTURE = { w: 3, h: 2, data: Uint8Array.from({ length: 24 }, (_, i) => (i % 4 === 3 ? 255 : i * 9)) };
const IMAGE = encodePng(PICTURE, 4, 4);

const SITE: FakeSite = {
  origin: ORIGIN,
  screens: {
    "/": {
      elements: [
        { id: "with", role: "button", roleGroup: "button_like", name: "Go", image: IMAGE },
        { id: "without", role: "button", roleGroup: "button_like", name: "Stop" },
      ],
    },
  },
};

async function open() {
  const opened = await new SnapshotSurface(SITE).open({
    origin: ORIGIN,
    allowlist: { check: () => ({ allowed: true, irreversible: false }), popups: false },
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timeZone: "America/New_York",
    visible: false,
  });
  if (!opened.ok) throw new Error("open failed");
  const eyes = opened.value.eyes;
  const o = await eyes.observe();
  if (!o.ok) throw new Error("observe failed");
  const ref = (name: string): ElementRef => {
    const found = o.value.elements.find((e) => e.clues.name === name);
    if (found === undefined) throw new Error("no such element");
    return found.ref;
  };
  return { eyes, ref };
}

describe("snapshot fake crop", () => {
  test("the fake crop returns image bytes, the old image, and stale_element", async () => {
    // an element with `image` returns exactly those bytes, and decodePng reads them.
    {
      const { eyes, ref } = await open();
      const got = await eyes.crop(ref("Go"));
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(Array.from(got.value)).toEqual(Array.from(IMAGE));
      const px = decodePng(got.value);
      expect(px.ok && Array.from(px.value.data)).toEqual(Array.from(PICTURE.data));
    }

    // an element without `image` returns the old fake image, not a real PNG.
    {
      const { eyes, ref } = await open();
      const got = await eyes.crop(ref("Stop"));
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(Array.from(got.value)).not.toEqual(Array.from(IMAGE));
      expect(decodePng(got.value).ok).toBe(false);
    }

    // a stale ref is stale_element.
    {
      const { eyes } = await open();
      expect(await eyes.crop("999/with" as unknown as ElementRef)).toEqual({
        ok: false,
        failure: "stale_element",
      });
    }
  });
});
