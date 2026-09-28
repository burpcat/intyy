// The canary scanner: looks for marker values in written files, four ways.
// Follows design section 4 §14, "How the canary scans work": raw, base64, URL-encoded, and
// HTML-escaped. One hit fails. Core reads no files, so callers pass the bytes in.

/** One file to scan: its path inside the scanned folder, and its bytes. */
export type ScanFile = { path: string; bytes: Uint8Array };

/** How a marker was found. */
export type CanaryForm = "raw" | "base64" | "url" | "html";

/** One hit. It names the marker's position in the list, never the marker, so the report is safe to print. */
export type CanaryHit = { path: string; marker: number; form: CanaryForm };

/** Base64 of `bytes`, standard or URL-safe, with no padding. */
function base64(bytes: Uint8Array, urlSafe: boolean): string {
  const s = Buffer.from(bytes).toString(urlSafe ? "base64url" : "base64");
  return s.replace(/=+$/, "");
}

/**
 * The base64 texts a marker shows as, at each of the three byte alignments. Only characters
 * that depend on marker bytes alone are kept, so a hit does not depend on the bytes around it.
 */
function base64Forms(marker: string): string[] {
  const m = new TextEncoder().encode(marker);
  const forms: string[] = [];
  for (const urlSafe of [false, true]) {
    for (let k = 0; k < 3; k += 1) {
      const padded = new Uint8Array(k + m.length);
      padded.set(m, k);
      const text = base64(padded, urlSafe);
      const first = Math.ceil((8 * k) / 6);
      const last = Math.floor((8 * (k + m.length)) / 6);
      forms.push(text.slice(first, last));
    }
  }
  return [...new Set(forms)].filter((f) => f.length >= 4);
}

/** The URL-encoded texts a marker shows as: percent codes in both cases, and `+` for spaces. */
function urlForms(marker: string): string[] {
  const upper = encodeURIComponent(marker);
  const lower = upper.replace(/%[0-9A-F]{2}/g, (c) => c.toLowerCase());
  return [...new Set([upper, lower, upper.replace(/%20/g, "+")])];
}

/** The HTML-escaped texts a marker shows as: named, decimal, and hex entities. */
function htmlForms(marker: string): string[] {
  const named: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  const all = (pick: (c: string) => string): string => Array.from(marker, pick).join("");
  return [
    ...new Set([
      all((c) => named[c] ?? c),
      all((c) => (/[\w-]/.test(c) ? c : `&#${String(c.codePointAt(0))};`)),
      all((c) => (/[\w-]/.test(c) ? c : `&#x${(c.codePointAt(0) ?? 0).toString(16)};`)),
      all((c) => `&#${String(c.codePointAt(0))};`),
    ]),
  ];
}

/**
 * Scans files for markers (section 4 §14). Bytes are read as Latin-1, so a hit in any text
 * file or plain binary is found. Every form of every marker is checked in every file.
 */
export function scanForCanaries(
  files: Iterable<ScanFile>,
  markers: readonly string[],
): CanaryHit[] {
  // Why: files are read as Latin-1, so each needle gets the same view of its UTF-8 bytes.
  const view = (needles: string[]): string[] =>
    needles.map((n) => Buffer.from(n, "utf8").toString("latin1"));
  const forms = markers.map((m) => ({
    raw: view([m]),
    base64: base64Forms(m),
    url: view(urlForms(m).filter((f) => f !== m)),
    html: view(htmlForms(m).filter((f) => f !== m)),
  }));
  const hits: CanaryHit[] = [];
  for (const f of files) {
    const text = Buffer.from(f.bytes).toString("latin1");
    for (const [marker, byForm] of forms.entries()) {
      for (const form of ["raw", "base64", "url", "html"] as const) {
        if (byForm[form].some((needle) => text.includes(needle)))
          hits.push({ path: f.path, marker, form });
      }
    }
  }
  return hits;
}
