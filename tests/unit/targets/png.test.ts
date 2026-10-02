// Proves decodePng (design section 7 §6.3, `image` clue; M08 decision "no image library"):
// every filter type round-trips through the test encoder, and bad or unsupported input returns
// a failure value and never throws.
import { describe, expect, test } from "vitest";
import { decodePng, type Pixels } from "../../../src/core/targets/png.js";
import { encodePng, type PngFilter } from "../../../src/fakes/png.js";

/** A non-square picture (7 wide, 5 high) with varied values and alpha 255. */
function pixels(w = 7, h = 5): Pixels {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = (i * 37 + 11) % 256;
    data[i * 4 + 1] = (i * 91 + 200) % 256;
    data[i * 4 + 2] = (i * i * 13) % 256;
    data[i * 4 + 3] = 255;
  }
  return { w, h, data };
}

const FILTERS: (PngFilter | "mixed")[] = [0, 1, 2, 3, 4, "mixed"];

describe("decodePng round trip", () => {
  test("every filter type and channel count round-trips through the test encoder", () => {
    for (const filter of FILTERS) {
      for (const channels of [3, 4] as const) {
        const label = `filter ${String(filter)}, ${String(channels)} channels`;
        const px = pixels();
        const got = decodePng(encodePng(px, filter, channels));
        expect(got.ok, label).toBe(true);
        if (!got.ok) continue;
        expect(got.value.w, label).toBe(7);
        expect(got.value.h, label).toBe(5);
        expect(Array.from(got.value.data), label).toEqual(Array.from(px.data));
      }
    }
  });
});

/** The PNG header layout the encoder writes: signature 8, IHDR chunk 8..32, IDAT body at 41. */
const IHDR_WIDTH = 16;
const IHDR_HEIGHT = 20;
const IHDR_DEPTH = 24;
const IHDR_COLOR = 25;
const IHDR_INTERLACE = 28;
const IDAT_BODY = 41;

function patched(at: number, bytes: number[]): Uint8Array {
  const out = encodePng(pixels());
  out.set(bytes, at);
  return out;
}

describe("decodePng failures", () => {
  test("bad and unsupported input gives a failure value", () => {
    // short or garbage input is bad_png.
    {
      expect(decodePng(new Uint8Array(0))).toEqual({ ok: false, failure: "bad_png" });
      expect(decodePng(Uint8Array.from([1, 2, 3]))).toEqual({ ok: false, failure: "bad_png" });
      expect(decodePng(new TextEncoder().encode("this is not a picture at all"))).toEqual({
        ok: false,
        failure: "bad_png",
      });
    }

    // a truncated file is bad_png.
    {
      const whole = encodePng(pixels());
      expect(decodePng(whole.slice(0, 20))).toMatchObject({ ok: false, failure: "bad_png" });
      expect(decodePng(whole.slice(0, whole.length - 17))).toMatchObject({ ok: false, failure: "bad_png" });
    }

    // a corrupt IDAT is bad_png.
    {
      expect(decodePng(patched(IDAT_BODY, [255, 255, 255, 255, 255, 255]))).toEqual({
        ok: false,
        failure: "bad_png",
      });
    }

    // bit depth 16, palette color, and interlace are unsupported_png.
    {
      expect(decodePng(patched(IHDR_DEPTH, [16]))).toEqual({ ok: false, failure: "unsupported_png" });
      expect(decodePng(patched(IHDR_COLOR, [3]))).toEqual({ ok: false, failure: "unsupported_png" });
      expect(decodePng(patched(IHDR_INTERLACE, [1]))).toEqual({ ok: false, failure: "unsupported_png" });
    }

    // zero width or zero height is bad_png.
    {
      expect(decodePng(patched(IHDR_WIDTH, [0, 0, 0, 0]))).toEqual({ ok: false, failure: "bad_png" });
      expect(decodePng(patched(IHDR_HEIGHT, [0, 0, 0, 0]))).toEqual({ ok: false, failure: "bad_png" });
    }

    // a huge claimed size is bad_png, not an allocation.
    {
      expect(decodePng(patched(IHDR_WIDTH, [0x7f, 0xff, 0xff, 0xff]))).toEqual({
        ok: false,
        failure: "bad_png",
      });
    }
  });

  test("it never throws on damaged files (every cut and a byte flip per position)", () => {
    const whole = encodePng(pixels(), "mixed");
    for (let n = 0; n < whole.length; n++) {
      expect(() => decodePng(whole.slice(0, n))).not.toThrow();
      const flipped = whole.slice();
      flipped[n] = (flipped[n] ?? 0) ^ 0xff;
      expect(() => decodePng(flipped)).not.toThrow();
    }
  });
});
