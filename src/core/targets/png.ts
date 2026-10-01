// Reads a PNG file into plain pixels, for picture likeness. Follows design section 7 §6.3
// (`image` clue: "a plain-code comparison", no model) and the M08 decision to use no image
// library. Only the PNG shape a browser screenshot has is read: 8-bit, RGB or RGBA, no interlace.
import { inflateSync } from "node:zlib";
import { fail, ok, type Outcome } from "../../ports/outcome.js";

/** Decoded pixels: `data` holds `w * h` pixels of 4 bytes each (red, green, blue, alpha). */
export type Pixels = { w: number; h: number; data: Uint8Array };

/** `bad_png`: not a readable PNG. `unsupported_png`: a PNG shape this reader does not handle. */
export type PngFailure = "bad_png" | "unsupported_png";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Why: a bound stops a tiny file that claims a huge picture from using all memory. */
const MAX_PIXELS = 16_000_000;

/** The Paeth predictor of the PNG spec (filter type 4). */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decodes a PNG. Expected bad input returns a failure; it never throws. CRC checks are skipped:
 * a damaged picture then gets a low likeness, which is the safe side.
 */
export function decodePng(bytes: Uint8Array): Outcome<Pixels, PngFailure> {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) return fail("bad_png");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header: { w: number; h: number; channels: number } | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  for (let at = 8; at + 8 <= bytes.length && !ended; ) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (body.length < len) return fail("bad_png");
    if (type === "IHDR") {
      if (len < 13) return fail("bad_png");
      const [depth, color, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) return fail("unsupported_png");
      header = { w: view.getUint32(at + 8), h: view.getUint32(at + 12), channels: color === 6 ? 4 : 3 };
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      ended = true;
    }
    at += 12 + len;
  }
  if (header === null || idat.length === 0) return fail("bad_png");
  const { w, h, channels } = header;
  if (w === 0 || h === 0 || w * h > MAX_PIXELS) return fail("bad_png");
  const stride = w * channels;
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return fail("bad_png");
  }
  if (raw.length !== (stride + 1) * h) return fail("bad_png");
  const data = new Uint8Array(w * h * 4).fill(255);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? (line[i - channels] ?? 0) : 0;
      const up = prev[i] ?? 0;
      const upLeft = i >= channels ? (prev[i - channels] ?? 0) : 0;
      let add: number;
      if (filter === 0) add = 0;
      else if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) add = paeth(left, up, upLeft);
      else return fail("bad_png");
      line[i] = ((line[i] ?? 0) + add) & 0xff;
    }
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) data[(y * w + x) * 4 + c] = line[x * channels + c] ?? 0;
    }
    prev = line;
  }
  return ok({ w, h, data });
}
