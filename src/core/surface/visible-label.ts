// The visible label of a field: the nearest text to its left in the same row, or directly above.
// Follows design section 6 §13.2. It comes from layout, not markup, so a field whose `<label for>`
// tie was dropped (`KVFCU_DROP_LABELS`) still has a label. Section 7 reuses the rule in replay.
import type { Box, SurfaceElement } from "../../ports/surface.js";

/** How far a label may sit to the left, in CSS pixels. */
const MAX_LEFT = 400;
/** How far a label may sit above, in CSS pixels. */
const MAX_ABOVE = 60;
/** Slack for boxes that touch or overlap by a pixel or two. */
const SLACK = 4;

/** True when two boxes share some height. */
const sameRow = (a: Box, b: Box): boolean => a.y < b.y + b.height && b.y < a.y + a.height;
/** True when two boxes share some width. */
const sameColumn = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width;

/** The text a label candidate shows, or undefined when it is not plain text. */
function labelText(e: SurfaceElement): string | undefined {
  if (e.roleGroup !== "container" || e.field !== undefined) return undefined;
  const t = (e.clues.text ?? "").trim();
  return t === "" ? undefined : t;
}

/**
 * The field's visible label, or undefined. Only fields get one: text boxes, choices, and checks.
 * The nearest text on the left wins; else the nearest text directly above.
 * ponytail: fixed pixel limits; learn them per app if a layout needs more room.
 */
export function visibleLabel(
  el: SurfaceElement,
  elements: readonly SurfaceElement[],
): string | undefined {
  if (!["text_entry", "choice", "check"].includes(el.roleGroup) || el.box === null)
    return undefined;
  const box = el.box;
  let left: { gap: number; text: string } | undefined;
  let above: { gap: number; text: string } | undefined;
  for (const c of elements) {
    const text = labelText(c);
    if (c === el || c.box === null || text === undefined) continue;
    const leftGap = box.x - (c.box.x + c.box.width);
    if (sameRow(box, c.box) && leftGap >= -SLACK && leftGap <= MAX_LEFT) {
      if (left === undefined || leftGap < left.gap) left = { gap: leftGap, text };
    }
    const aboveGap = box.y - (c.box.y + c.box.height);
    if (sameColumn(box, c.box) && aboveGap >= -SLACK && aboveGap <= MAX_ABOVE) {
      if (above === undefined || aboveGap < above.gap) above = { gap: aboveGap, text };
    }
  }
  return (left ?? above)?.text;
}
