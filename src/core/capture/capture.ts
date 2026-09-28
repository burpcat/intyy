// The capture helper: a screenshot and snapshots, masked, then written to the run folder.
// Follows design section 3 §7.1 (folders), §7.4 (file names), §7.5 (what to capture), §7.6,
// §7.7 (what never goes in), and section 4 §9.11 to §9.13 (masking; screenshots fail closed).
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { RunFolder } from "../../ports/stores.js";
import type { Eyes } from "../../ports/surface.js";
import { maskedScreenshot, type Withheld } from "../safety/redaction/images.js";
import type { Redactor } from "../safety/redaction/redactor.js";
import { maskA11y, maskDom } from "../safety/redaction/snapshots.js";

/** What to capture at one moment (section 3 §7.5). */
export type CaptureWhat = { screenshot: boolean; dom: boolean; a11y: boolean };

/**
 * Where the files go: `seq` is the log line number, `name` the step and moment in lower case,
 * like `click_search_ladder`. Files are `screens/00019_click_search_ladder.png` and so on.
 */
export type CaptureAt = { seq: number; name: string };

/** What was written, and any screenshot withheld (warning `screenshot_withheld`, section 4 §9.11). */
export type CaptureResult = { files: string[]; withheld: Withheld | null };

/** A file name part: lower case words joined by `_`. */
const NAME = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * Captures one moment. Every byte passes the redactor before the write. A screenshot that cannot
 * be masked is withheld and the run goes on. A failed write returns `write_failed`.
 */
export async function capture(
  eyes: Eyes,
  r: Redactor,
  folder: RunFolder,
  at: CaptureAt,
  what: CaptureWhat,
  signal?: AbortSignal,
): Promise<Outcome<CaptureResult, "write_failed">> {
  if (!NAME.test(at.name) || !Number.isInteger(at.seq) || at.seq < 0) {
    throw new Error(`bad capture name: ${String(at.seq)} ${at.name}`);
  }
  const base = `${String(at.seq).padStart(5, "0")}_${at.name}`;
  const files: string[] = [];
  let withheld: Withheld | null = null;

  if (what.screenshot) {
    const shot = await maskedScreenshot(eyes, r, signal);
    if (shot.ok) {
      const path = `screens/${base}.png`;
      const w = await folder.writeFile(path, shot.value, signal);
      if (!w.ok) return fail("write_failed");
      files.push(path);
    } else {
      withheld = shot.failure;
    }
  }

  if (what.dom || what.a11y) {
    const snaps = await eyes.snapshots(signal);
    if (snaps.ok) {
      if (what.dom) {
        const path = `dom/${base}.html`;
        const w = await folder.writeFile(path, maskDom(snaps.value.dom, r), signal);
        if (!w.ok) return fail("write_failed");
        files.push(path);
      }
      if (what.a11y) {
        const path = `a11y/${base}.yaml`;
        const w = await folder.writeFile(path, maskA11y(snaps.value.a11y, r), signal);
        if (!w.ok) return fail("write_failed");
        files.push(path);
      }
    }
  }
  return ok({ files, withheld });
}
