// A tiny PNG writer for tests: real PNG bytes from RGBA pixels, with a chosen filter type.
// Follows design section 7 §6.3 (`image` clue); the decoder it tests is `core/targets/png.ts`.
import { deflateSync } from "node:zlib";
import type { Pixels } from "../core/targets/png.js";

/** A PNG filter type: 0 none, 1 sub, 2 up, 3 average, 4 Paeth. */
export type PngFilter = 0 | 1 | 2 | 3 | 4;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  // CRC stays zero: the decoder does not check it (see decodePng).
  return out;
}

/**
 * Encodes pixels as an 8-bit, non-interlaced PNG. `channels` 4 writes RGBA; 3 drops alpha (RGB).
 * `filter` picks one filter type for every row, or `"mixed"` cycles all five by row.
 */
export function encodePng(p: Pixels, filter: PngFilter | "mixed" = 0, channels: 3 | 4 = 4): Uint8Array {
  const stride = p.w * channels;
  const raw = new Uint8Array((stride + 1) * p.h);
  const rowOf = (y: number): Uint8Array => {
    const row = new Uint8Array(stride);
    for (let x = 0; x < p.w; x++) {
      for (let c = 0; c < channels; c++) row[x * channels + c] = p.data[(y * p.w + x) * 4 + c] ?? 0;
    }
    return row;
  };
  for (let y = 0; y < p.h; y++) {
    const f = filter === "mixed" ? ((y % 5) as PngFilter) : filter;
    const row = rowOf(y);
    const prev = y > 0 ? rowOf(y - 1) : new Uint8Array(stride);
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? (row[i - channels] ?? 0) : 0;
      const up = prev[i] ?? 0;
      const upLeft = i >= channels ? (prev[i - channels] ?? 0) : 0;
      const predict = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][f] ?? 0;
      raw[y * (stride + 1) + 1 + i] = ((row[i] ?? 0) - predict) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, p.w);
  v.setUint32(4, p.h);
  ihdr.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  return Buffer.concat(parts);
}
