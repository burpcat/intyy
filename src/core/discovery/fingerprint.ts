// Fingerprint capture: everything the recorder and replay need about an acted control, taken
// before the action. Follows design section 6 §13.1 (what is captured), §13.2 (visible label),
// and section 4 §9.12 (crops: button-like controls and empty inputs only, never a boxed one).
import type { Masked } from "../../ports/masked.js";
import type { RunFolder } from "../../ports/stores.js";
import type { ElementRef, Eyes, Observation, SurfaceElement } from "../../ports/surface.js";
import { maskedCrop } from "../safety/redaction/images.js";
import type { Redactor } from "../safety/redaction/redactor.js";
import { childrenOf, maskedName } from "./observation.js";

/** Roles that name a container for `within` (section 6 §13.1). */
const CONTAINERS = new Set(["form", "table", "grid", "dialog", "alertdialog", "row"]);

/** The facts of one acted control. Text is masked; `crop` is a file in the run folder. */
export type Fingerprint = {
  role: string;
  name: Masked<string> | null;
  label: Masked<string> | null;
  text: Masked<string> | null;
  /** Document position and size divided by the viewport size. Scrolling does not move it. */
  region: { x: number; y: number; w: number; h: number } | null;
  crop: string | null;
  /** Why no crop was kept, when none was. */
  crop_dropped: string | null;
  path: Masked<string>;
  within: Masked<string> | null;
  /** The field's max length. The eyes do not report it yet, so it is null. */
  max_length: null;
  field_kind: "text" | "password" | "choice" | "check" | null;
  /** How many elements share this role and name. */
  uniqueness: number;
};

/** Four decimal places: enough to tell controls apart, stable across runs. */
const round = (n: number): number => Math.round(n * 10_000) / 10_000;

/** The nearest named container above `el`, as `role "name"`, masked. */
function withinOf(
  r: Redactor,
  el: SurfaceElement,
  o: Observation,
  kids: ReturnType<typeof childrenOf>,
): Masked<string> | null {
  const byRef = new Map(o.elements.map((e) => [e.ref, e]));
  for (let p = el.parent; p !== undefined; p = byRef.get(p)?.parent) {
    const c = byRef.get(p);
    if (c === undefined) return null;
    const name = maskedName(r, c, kids);
    if (CONTAINERS.has(c.role) && name !== null) return r.text(`${c.role} "${name}"`);
  }
  return null;
}

/**
 * Captures one control's fingerprint before it is acted on (section 6 §10.1 step 6). A crop is
 * written to `crops/<seq>_<id>.png` when the crop rules allow it; an input is cropped empty.
 */
export async function captureFingerprint(
  eyes: Eyes,
  r: Redactor,
  folder: RunFolder,
  o: Observation,
  target: ElementRef,
  at: { seq: number; id: string; label: string | undefined },
  signal?: AbortSignal,
): Promise<Fingerprint | "write_failed" | null> {
  const el = o.elements.find((e) => e.ref === target);
  if (el === undefined) return null;
  const kids = childrenOf(o.elements);
  const crop = await maskedCrop(eyes, o, target, r, signal);
  let cropPath: string | null = null;
  if (crop.ok) {
    cropPath = `crops/${String(at.seq).padStart(5, "0")}_${at.id}.png`;
    const w = await folder.writeFile(cropPath, crop.value, signal);
    if (!w.ok) return "write_failed";
  }
  const name = el.clues.name ?? "";
  const vw = o.viewport.width;
  const vh = o.viewport.height;
  return {
    role: el.role,
    name: el.clues.name === undefined ? null : maskedName(r, el, kids),
    label: at.label === undefined ? null : r.text(at.label),
    text:
      el.clues.text === undefined || el.field !== undefined
        ? null
        : maskedName(r, { ...el, clues: { ...el.clues, name: el.clues.text } }, kids),
    region:
      el.box === null
        ? null
        : {
            x: round(el.box.x / vw),
            y: round(el.box.y / vh),
            w: round(el.box.width / vw),
            h: round(el.box.height / vh),
          },
    crop: cropPath,
    crop_dropped: crop.ok ? null : crop.failure,
    path: r.text(el.clues.path),
    within: withinOf(r, el, o, kids),
    max_length: null,
    field_kind: el.field?.kind ?? null,
    uniqueness: o.elements.filter((e) => e.role === el.role && (e.clues.name ?? "") === name)
      .length,
  };
}
