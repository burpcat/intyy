// Builds the raw accessibility snapshot, a nested tree in Playwright's YAML line form, from the
// eyes' own element list. Never from Playwright's `ariaSnapshot`, which prints field values.
// Follows docs/formats/a11y-snapshot.md, section 3 §7.6, and section 4 §2.6. The core masks it.
import type { SurfaceElement } from "../../ports/surface.js";

/** Writes a name in double quotes, with `\` and `"` escaped. */
const quote = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The state flags a line shows, in Playwright's bracket form. Never a value. */
function flags(e: SurfaceElement): string {
  const out: string[] = [];
  if (e.field?.kind === "check" && e.field.checked === true) out.push("[checked]");
  if (!e.enabled) out.push("[disabled]");
  return out.map((f) => ` ${f}`).join("");
}

/** One element's own line, without indent. `open` adds the `:` that starts a child block. */
function line(e: SurfaceElement, open: boolean): string {
  const name = e.clues.name ?? e.clues.label;
  if (e.role === "generic") {
    // Why: a text-only element prints as Playwright's `- text:` line (format note, line kinds).
    if (!open && e.clues.text !== undefined) return `- text: ${e.clues.text}`;
    return `- generic${open ? ":" : ""}`;
  }
  const named = name === undefined ? "" : ` ${quote(name)}`;
  return `- ${e.role}${named}${flags(e)}${open ? ":" : ""}`;
}

/**
 * The raw accessibility snapshot of one observation (docs/formats/a11y-snapshot.md).
 * Each element sits under its `parent`, two spaces deeper; order is the element list's order.
 * A plain link carries a `- /url:` child. Field values never appear.
 */
export function a11yTree(elements: readonly SurfaceElement[]): string {
  const known = new Set(elements.map((e) => e.ref));
  const children = new Map<SurfaceElement["ref"] | null, SurfaceElement[]>();
  for (const e of elements) {
    // Why: a parent missing from the list, such as one in a closed frame, makes a top element.
    const key = e.parent !== undefined && known.has(e.parent) ? e.parent : null;
    children.set(key, [...(children.get(key) ?? []), e]);
  }
  const out: string[] = [];
  const walk = (e: SurfaceElement, depth: number): void => {
    const kids = children.get(e.ref) ?? [];
    const pad = "  ".repeat(depth);
    out.push(pad + line(e, kids.length > 0 || e.href !== undefined));
    if (e.href !== undefined) out.push(`${pad}  - /url: ${e.href}`);
    for (const k of kids) walk(k, depth + 1);
  };
  for (const e of children.get(null) ?? []) walk(e, 0);
  return out.join("\n");
}
