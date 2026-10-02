// Proves picture likeness, the `image` degree, and the `region` degree edges (design section 7
// §6.3: image 1 at likeness 0.90, 0 at 0.60; region 1 within 3% of the viewport, 0 at 20%).
// Pictures are made-up pixels. Gate row: "Region and image degree edges". M08.
import { describe, expect, test } from "vitest";
import { imageDegree, likeness } from "../../../src/core/targets/likeness.js";
import type { Pixels } from "../../../src/core/targets/png.js";
import { regionDegree } from "../../../src/core/targets/vote.js";

/** A picture of `w` by `h`, each pixel gray `f(x, y)`, alpha 255. */
function gray(w: number, h: number, f: (x: number, y: number) => number): Pixels {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = f(x, y);
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  return { w, h, data };
}

const checker = (x: number, y: number): number => ((x + y) % 2 === 0 ? 0 : 255);
const inverse = (x: number, y: number): number => 255 - checker(x, y);
const ramp = (x: number): number => x * 20;

describe("likeness", () => {
  test("likeness scores identical, inverse, scaled, and reshaped pictures as the design says", () => {
    // identical pictures are exactly 1.
    {
      expect(likeness(gray(10, 10, ramp), gray(10, 10, ramp))).toBe(1);
    }

    // black and white against its inverse is under 0.05.
    {
      expect(likeness(gray(10, 10, checker), gray(10, 10, inverse))).toBeLessThan(0.05);
    }

    // the same picture at 2x is 1.
    {
      const small = gray(10, 10, (x, y) => (x * 25 + y * 7) % 256);
      const big = gray(20, 20, (x, y) => (Math.floor(x / 2) * 25 + Math.floor(y / 2) * 7) % 256);
      expect(likeness(small, big)).toBeCloseTo(1, 10);
      expect(likeness(big, small)).toBeCloseTo(1, 10);
    }

    // a different aspect ratio is 0 (20x10 against 10x10).
    {
      const flat = (): number => 100;
      expect(likeness(gray(10, 10, flat), gray(20, 10, flat))).toBe(0);
    }

    // an area ratio over 4 is 0; exactly 4 is still compared.
    {
      const flat = (): number => 100;
      expect(likeness(gray(10, 10, flat), gray(30, 30, flat))).toBe(0);
      expect(likeness(gray(30, 30, flat), gray(10, 10, flat))).toBe(0);
      expect(likeness(gray(10, 10, flat), gray(20, 20, flat))).toBeCloseTo(1, 10);
    }

    // an aspect ratio of 1.2 is still compared.
    {
      const flat = (): number => 100;
      expect(likeness(gray(10, 10, flat), gray(12, 10, flat))).toBeCloseTo(1, 10);
    }

    // a slightly different picture is strictly between 0 and 1.
    {
      const a = gray(10, 10, ramp);
      const b = gray(10, 10, (x, y) => (x === 3 && y === 4 ? 255 : ramp(x)));
      const l = likeness(a, b);
      expect(l).toBeGreaterThan(0);
      expect(l).toBeLessThan(1);
    }

    // a changed pixel in alpha alone does not change likeness (screenshots are opaque).
    {
      const a = gray(4, 4, ramp);
      const b = gray(4, 4, ramp);
      b.data[3] = 0;
      expect(likeness(a, b)).toBe(1);
    }
  });
});

describe("imageDegree (section 7 §6.3, image)", () => {
  test("imageDegree maps likeness to a degree between its two cutoffs", () => {
    // null stays null: no candidate crop, the clue is missing.
    {
      expect(imageDegree(null)).toBeNull();
    }

    // 0.90 and above is 1.
    {
      expect(imageDegree(0.95)).toBe(1);
      expect(imageDegree(0.9)).toBe(1);
      expect(imageDegree(1)).toBe(1);
    }

    // 0.60 and below is 0.
    {
      expect(imageDegree(0.6)).toBe(0);
      expect(imageDegree(0.3)).toBe(0);
      expect(imageDegree(0)).toBe(0);
    }

    // linear between 0.60 and 0.90.
    {
      expect(imageDegree(0.75)).toBeCloseTo(0.5, 10);
      expect(imageDegree(0.69)).toBeCloseTo(0.3, 10);
      expect(imageDegree(0.84)).toBeCloseTo(0.8, 10);
    }
  });
});

describe("regionDegree (section 7 §6.3, region)", () => {
  /** A same-size box whose center sits `dx` to the right of (0.5, 0.5). */
  const at = (dx: number): { x: number; y: number; w: number; h: number } => ({ x: 0.5 + dx, y: 0.5, w: 0.1, h: 0.05 });
  const base = at(0);

  test("regionDegree maps distance to a degree", () => {
    // same place is 1.
    {
      expect(regionDegree(base, base)).toBe(1);
    }

    // within 0.03 is 1.
    {
      expect(regionDegree(base, at(0.03))).toBeCloseTo(1, 10);
      expect(regionDegree(base, at(0.02))).toBe(1);
    }

    // 0.115 is 0.5.
    {
      expect(regionDegree(base, at(0.115))).toBeCloseTo(0.5, 10);
    }

    // 0.20 and beyond is 0.
    {
      expect(regionDegree(base, at(0.2))).toBeCloseTo(0, 10);
      expect(regionDegree(base, at(0.5))).toBe(0);
    }

    // distance is Euclidean, not per axis.
    {
      // 0.15 right and 0.15 down is 0.212 away: 0. Each axis alone would be under 0.20.
      expect(regionDegree(base, { ...base, x: 0.65, y: 0.65 })).toBe(0);
    }
  });
});
