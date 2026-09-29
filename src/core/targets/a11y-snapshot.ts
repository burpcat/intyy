// Parses a saved, masked accessibility snapshot (`docs/formats/a11y-snapshot.md`) into a
// {@link ScreenView}, for the recorder's landmark check (section 6 §14.5: "found by comparing
// the two snapshots"). Field values and boxes never appear in this format, so those stay absent.
import type { RoleGroup } from "../../ports/surface.js";
import type { ScreenElement, ScreenView } from "./screen.js";

/** A rough role-to-group map, for the small set of roles a snapshot names (section 3 §7.6). Only
 * used here, to fill {@link ScreenElement.roleGroup}; the live risk classifier has its own,
 * fuller table (section 4 §7.4), which this does not need to match. */
const GROUP: Record<string, RoleGroup> = {
  button: "button_like",
  link: "navigation",
  textbox: "text_entry",
  searchbox: "text_entry",
  spinbutton: "text_entry",
  combobox: "choice",
  listbox: "choice",
  option: "choice",
  checkbox: "check",
  radio: "check",
};

/** One parsed line, before it is placed in the tree. */
type Line = { depth: number; role: string; name?: string; text?: string; checked?: boolean; disabled?: boolean };

/** One line's depth: leading spaces, two per level, before its `- `. */
function depthOf(raw: string): number {
  const spaces = /^ */.exec(raw)?.[0].length ?? 0;
  return Math.floor(spaces / 2);
}

/** One line's content, after `- ` (section "Line kinds"). `null` for a line this parser skips:
 * a link's `/url:` child, which holds an address, not user-visible text. */
function parseLine(raw: string): Line | null {
  const depth = depthOf(raw);
  const content = raw.trim().replace(/^- /, "");
  if (content.startsWith("/url:")) return null;
  if (content.startsWith("text:")) return { depth, role: "text", text: content.slice(5).trim() };
  const hasChildren = content.endsWith(":");
  const body = hasChildren ? content.slice(0, -1) : content;
  const m = /^([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(\s+\[[a-z, ]+\])?$/.exec(body.trim());
  if (m?.[1] === undefined) return { depth, role: body.trim() };
  const flags = m[3] ?? "";
  const name = m[2]?.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return {
    depth,
    role: m[1],
    ...(name === undefined ? {} : { name }),
    checked: flags.includes("checked"),
    disabled: flags.includes("disabled"),
  };
}

/**
 * Parses one saved `a11y/*.yaml` snapshot into a {@link ScreenView} at `location` (section 6
 * §14.5, section 2 §14). Nesting builds `parent`; there are no boxes or field values to fill.
 */
export function fromA11ySnapshot(text: string, location: string): ScreenView {
  const stack: { depth: number; id: string }[] = [];
  const elements: ScreenElement[] = [];
  let n = 0;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const parsed = parseLine(raw);
    if (parsed === null) continue;
    while ((stack[stack.length - 1]?.depth ?? -1) >= parsed.depth) stack.pop();
    const id = String(n++);
    const parent = stack[stack.length - 1]?.id;
    const el: ScreenElement = {
      id,
      role: parsed.role,
      roleGroup: GROUP[parsed.role] ?? "container",
      path: "",
      visible: true,
      enabled: parsed.disabled !== true,
    };
    if (parent !== undefined) el.parent = parent;
    // Why both clues: the format's own "Name" is "the accessible name, else the visible label"
    // (docs/formats/a11y-snapshot.md §3), so a target recorded under either clue still matches.
    if (parsed.name !== undefined) {
      el.name = parsed.name;
      el.label = parsed.name;
    }
    if (parsed.text !== undefined) el.text = parsed.text;
    if (parsed.checked === true) el.checked = true;
    elements.push(el);
    stack.push({ depth: parsed.depth, id });
  }
  return { location, elements };
}
