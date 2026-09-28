// Masked images: which elements get a box in a screenshot, and which crops may be kept.
// Follows design section 4 §2.7 (mask what you cannot read), §9.11 (what gets a box, drawn at
// capture, fail closed), §9.12 (image crops), and section 2 §13.4 (crop safety rules).
import type { Masked } from "../../../ports/masked.js";
import { fail, ok, type Outcome } from "../../../ports/outcome.js";
import type {
  Box,
  ElementRef,
  Eyes,
  Observation,
  Png,
  SurfaceElement,
} from "../../../ports/surface.js";
import type { Redactor } from "./redactor.js";

/** The labels the label rule may read for an element: its own, its column header, its left cell. */
function labelsOf(el: SurfaceElement): (string | undefined)[] {
  return [undefined, el.clues.label, el.context?.column, el.context?.left];
}

/** True when the text rules change this text under any of the element's labels (rule 1). */
function changes(r: Redactor, text: string | undefined, el: SurfaceElement): boolean {
  if (text === undefined || text.trim() === "") return false;
  return labelsOf(el).some((label) => r.text(text, label === undefined ? {} : { label }) !== text);
}

/** True when box `inner` lies inside box `outer` and is smaller. Equal boxes are not inside. */
function inside(inner: Box, outer: Box): boolean {
  return (
    inner.width * inner.height < outer.width * outer.height &&
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** True when two boxes share any area. */
function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The elements that get a box, by rules 1 to 4 of section 4 §9.11. */
export function boxedElements(o: Observation, r: Redactor): SurfaceElement[] {
  const byText: SurfaceElement[] = [];
  const other: SurfaceElement[] = [];
  for (const el of o.elements) {
    const f = el.field;
    if (el.unreadable === true)
      other.push(el); // rule 4
    else if (f?.filled === true)
      other.push(el); // rule 3
    else if ((f?.kind === "text" || f?.kind === "password") && (f.value ?? "") !== "")
      other.push(el); // rule 2
    else if (f?.kind === "choice" && changes(r, f.value, el))
      other.push(el); // rule 2, dropdowns
    else if ([el.clues.text, el.clues.name, el.tooltip].some((t) => changes(r, t, el)))
      byText.push(el); // rule 1
  }
  // Why: rule 1 boxes the smallest element that holds the text. Drop a container whose box holds
  // another boxed element. Without boxes, keep both: more masking is the safe side.
  const smallest = byText.filter(
    (outer) =>
      outer.box === null ||
      !byText.some(
        (inner) =>
          inner !== outer &&
          inner.box !== null &&
          outer.box !== null &&
          inside(inner.box, outer.box),
      ),
  );
  return [...other, ...smallest];
}

/** Makes a Masked value. Why a cast: the brand has no runtime form (section 9 §5.1). */
function mask<T>(value: T): Masked<T> {
  return value as Masked<T>;
}

/** Why a screenshot was withheld. The run logs a `screenshot_withheld` warning (section 4 §9.11). */
export type Withheld = "dialog_open" | "page_gone" | "stale_mask" | "screen_changed";

/** The set of refs, as sorted text, to compare two box lists. */
const refKey = (els: readonly SurfaceElement[]): string =>
  els
    .map((e) => e.ref as unknown as string)
    .sort()
    .join("\n");

/**
 * Takes a screenshot with every box drawn at capture time (section 4 §9.11). Fails closed: when
 * the boxes cannot be worked out, or the screen changed while shooting, nothing comes back.
 */
export async function maskedScreenshot(
  eyes: Eyes,
  r: Redactor,
  signal?: AbortSignal,
): Promise<Outcome<Masked<Png>, Withheld>> {
  const before = await eyes.observe(signal);
  if (!before.ok) return fail("page_gone");
  // Why: a native box is not in the page picture, and its message cannot be boxed.
  if (before.value.dialog !== null) return fail("dialog_open");
  const boxed = boxedElements(before.value, r);
  const shot = await eyes.screenshot(
    boxed.map((e) => e.ref),
    signal,
  );
  if (!shot.ok) return fail(shot.failure === "stale_element" ? "stale_mask" : "page_gone");
  // Why: an element that appeared after the first look would have no box. Look again, and
  // withhold the picture unless the box list is the same.
  const after = await eyes.observe(signal);
  if (!after.ok) return fail("page_gone");
  if (after.value.dialog !== null || refKey(boxedElements(after.value, r)) !== refKey(boxed)) {
    return fail("screen_changed");
  }
  return ok(mask(shot.value));
}

/** Why a crop was dropped (section 4 §9.12). The target keeps its other clues. */
export type CropDropped = "not_croppable" | "boxed" | "no_box" | "stale";

/**
 * Takes an image crop, if the rules allow it (section 4 §9.12): only a button-like control or an
 * empty input box, and never one that any mask box touches.
 */
export async function maskedCrop(
  eyes: Eyes,
  o: Observation,
  target: ElementRef,
  r: Redactor,
  signal?: AbortSignal,
): Promise<Outcome<Masked<Png>, CropDropped>> {
  const el = o.elements.find((e) => e.ref === target);
  if (el === undefined) return fail("stale");
  const f = el.field;
  const emptyInput =
    el.roleGroup === "text_entry" && f !== undefined && f.filled !== true && (f.value ?? "") === "";
  if (el.roleGroup !== "button_like" && !emptyInput) return fail("not_croppable");
  const boxed = boxedElements(o, r);
  if (boxed.includes(el)) return fail("boxed");
  // Why: fail closed. Without geometry, intyy cannot prove no box touches the crop.
  if (el.box === null || boxed.some((b) => b.box === null)) return fail("no_box");
  const box = el.box;
  if (boxed.some((b) => b.box !== null && overlaps(b.box, box))) return fail("boxed");
  const crop = await eyes.crop(target, signal);
  return crop.ok ? ok(mask(crop.value)) : fail("stale");
}
