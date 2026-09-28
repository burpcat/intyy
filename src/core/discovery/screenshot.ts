// The marked screenshot for one discovery turn: masked at capture, then tagged with this turn's
// element IDs. Follows design section 6 §8.4 and section 4 §9.11 (fail closed). A withheld picture
// means the LLM gets the element list only, and is told so.
import type { Marker, Tag } from "../../ports/marker.js";
import type { Masked } from "../../ports/masked.js";
import type { Eyes, Observation, Png } from "../../ports/surface.js";
import { markScreenshot, maskedScreenshot, type Withheld } from "../safety/redaction/images.js";
import type { Redactor } from "../safety/redaction/redactor.js";
import type { ScreenView } from "./observation.js";

/** The picture for one turn. `marked` is false when tags could not be drawn (section 3 §6.4). */
export type TurnPicture =
  | { png: Masked<Png>; marked: boolean; withheld: null }
  | { png: null; marked: false; withheld: Withheld };

/**
 * One tag per control on screen, at its place in the screenshot. Why controls only: the LLM acts
 * on controls, and tags on text would hide the words it reads (section 6 §8.4).
 */
export function tagsFor(view: ScreenView, o: Observation): Tag[] {
  const tags: Tag[] = [];
  for (const [id, el] of view.elements) {
    if (el.roleGroup === "container" || el.box === null) continue;
    const x = el.box.x - o.scroll.x;
    const y = el.box.y - o.scroll.y;
    const inView = x + el.box.width > 0 && y + el.box.height > 0;
    if (inView && x < o.viewport.width && y < o.viewport.height)
      tags.push({ text: id, box: { ...el.box, x, y } });
  }
  return tags;
}

/**
 * Takes the masked screenshot, then draws the tags (section 6 §8.4). A failed marker still
 * sends the masked picture, unmarked: it is safe, and the stored copy is the sent copy.
 */
export async function turnPicture(
  eyes: Eyes,
  marker: Marker,
  r: Redactor,
  view: ScreenView,
  o: Observation,
  signal?: AbortSignal,
): Promise<TurnPicture> {
  const shot = await maskedScreenshot(eyes, r, signal);
  if (!shot.ok) return { png: null, marked: false, withheld: shot.failure };
  const marked = await markScreenshot(marker, shot.value, tagsFor(view, o), signal);
  return marked === null
    ? { png: shot.value, marked: false, withheld: null }
    : { png: marked, marked: true, withheld: null };
}
