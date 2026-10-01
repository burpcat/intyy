// Picture likeness: how much a candidate's pixels look like the recorded crop. Follows design
// section 7 §6.3 (`image` clue: "a plain-code comparison of the crop with the candidate's pixels
// at the same scale. No model.") and section 2 §13.2. The metric and the guard are M08 decisions.
import type { Pixels } from "./png.js";

/** Why: a crop of another shape is another control. Aspect ratios may differ by 25% at most. */
const MAX_ASPECT_RATIO = 1.25;

/** Why: the same control at another window size is a few times larger or smaller, not more. */
const MAX_AREA_RATIO = 4;

/** Grayscale, one byte per pixel (the usual luma weights). */
function gray(p: Pixels): Float64Array {
  const out = new Float64Array(p.w * p.h);
  for (let i = 0; i < out.length; i++) {
    out[i] = 0.299 * (p.data[i * 4] ?? 0) + 0.587 * (p.data[i * 4 + 1] ?? 0) + 0.114 * (p.data[i * 4 + 2] ?? 0);
  }
  return out;
}

/** For each of `to` target cells, the source cells it covers and how much of each (area weight). */
function overlaps(from: number, to: number): { first: number; weights: number[] }[] {
  const span = from / to;
  return Array.from({ length: to }, (_, t) => {
    const start = t * span;
    const end = start + span;
    const first = Math.floor(start);
    const weights: number[] = [];
    for (let s = first; s < Math.min(from, Math.ceil(end)); s++) {
      weights.push((Math.min(end, s + 1) - Math.max(start, s)) / span);
    }
    return { first, weights };
  });
}

/** Area-resamples a gray image to `w` by `h`: each new pixel averages the old pixels it covers. */
function resample(src: Float64Array, sw: number, sh: number, w: number, h: number): Float64Array {
  const cols = overlaps(sw, w);
  const rows = overlaps(sh, h);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < w; x++) {
      const col = cols[x];
      if (row === undefined || col === undefined) continue;
      let sum = 0;
      row.weights.forEach((wy, j) => {
        col.weights.forEach((wx, i) => {
          sum += wy * wx * (src[(row.first + j) * sw + col.first + i] ?? 0);
        });
      });
      out[y * w + x] = sum;
    }
  }
  return out;
}

/**
 * Likeness of a candidate to the recorded crop, from 0 to 1 (section 7 §6.3). Both go to gray;
 * the candidate is area-resampled to the recorded size; likeness is 1 minus the mean absolute
 * difference over 255. A candidate of another shape or scale returns 0 (the size guard). Alpha
 * is ignored: browser screenshots are opaque.
 */
export function likeness(recorded: Pixels, candidate: Pixels): number {
  const aspect = recorded.w / recorded.h / (candidate.w / candidate.h);
  const area = (candidate.w * candidate.h) / (recorded.w * recorded.h);
  if (aspect > MAX_ASPECT_RATIO || aspect < 1 / MAX_ASPECT_RATIO) return 0;
  if (area > MAX_AREA_RATIO || area < 1 / MAX_AREA_RATIO) return 0;
  const a = gray(recorded);
  const b = resample(gray(candidate), candidate.w, candidate.h, recorded.w, recorded.h);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return 1 - diff / a.length / 255;
}

/**
 * The `image` clue's match degree (section 7 §6.3): null when the candidate has no crop (clue
 * missing); 1 at likeness 0.90 or more; 0 at 0.60 or less; linear between.
 */
export function imageDegree(likenessValue: number | null): number | null {
  if (likenessValue === null) return null;
  if (likenessValue >= 0.9) return 1;
  if (likenessValue <= 0.6) return 0;
  return (likenessValue - 0.6) / (0.9 - 0.6);
}
