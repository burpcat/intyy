// Masked DOM and accessibility snapshots: every text passes the text rules; values, hidden
// fields, scripts, and inline handlers are removed. Follows design section 4 §9.13 and
// section 3 §7.6 (what is kept, removed, and redacted).
import type { Masked } from "../../../ports/masked.js";
import type { Redactor } from "./redactor.js";

/** Attributes that can hold text. They pass the text rules (section 4 §9.13). */
const TEXT_ATTRS = new Set(["title", "alt", "aria-label", "placeholder", "aria-description"]);

/** Attributes that hold addresses. They pass the text rules, like page paths. */
const ADDRESS_ATTRS = new Set(["href", "src", "action", "formaction", "data"]);

/** Elements whose whole content is dropped. Old apps hide member data in them. */
const DROP_CONTENT = new Set(["script", "noscript", "template", "textarea"]);

/** One attribute: `name="value"`, `name='value'`, `name=value`, or a bare `name`. */
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Makes a Masked value. Why a cast: the brand has no runtime form (section 9 §5.1). */
function mask<T>(value: T): Masked<T> {
  return value as Masked<T>;
}

/** Escapes text for an attribute value. */
const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** Undoes the common HTML escapes, so the text rules see the real text. */
const unescape = (s: string): string =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** Escapes text for an HTML text node. */
const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Table position, for label-rule sources 2 and 3 (section 4 §9.7). */
type TableState = {
  headers: string[];
  col: number;
  row: number;
  left: string;
  inHead: boolean;
  cell: string;
};

/**
 * Masks a DOM snapshot (section 4 §9.13). A small tolerant tokenizer, not a full HTML parser:
 * anything it cannot read as a tag is text, so it passes the text rules.
 * ponytail: tables nest one level; nested tables share the outer header row.
 */
export function maskDom(html: string, r: Redactor): Masked<string> {
  const out: string[] = [];
  let i = 0;
  let drop: string | null = null;
  const table: TableState = { headers: [], col: -1, row: -1, left: "", inHead: false, cell: "" };
  let pendingText = "";

  const flushText = (): void => {
    if (pendingText === "") return;
    const raw = unescape(pendingText);
    pendingText = "";
    if (raw.trim() === "") {
      out.push(escapeText(raw));
      return;
    }
    // Why: section 4 §9.7, a cell's column header, else the cell to its left, is its label.
    const label =
      table.col >= 0 && !table.inHead
        ? (table.headers[table.col] ?? (table.left || undefined))
        : undefined;
    table.cell += raw;
    out.push(escapeText(r.text(raw, label === undefined ? {} : { label })));
  };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      if (drop === null) pendingText += html.slice(i);
      break;
    }
    if (drop === null) pendingText += html.slice(i, lt);
    // Comments and CDATA are dropped whole: they can hold data and are not shown.
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", lt)) {
      const end = html.indexOf("]]>", lt);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt);
    if (gt === -1) {
      if (drop === null) pendingText += html.slice(lt);
      break;
    }
    const tag = html.slice(lt + 1, gt);
    i = gt + 1;
    const m = /^(\/?)([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*?)(\/?)$/.exec(tag);
    if (m === null) {
      // `<!DOCTYPE html>` and stray `<` stay as they are; they carry no member text.
      if (drop === null) {
        flushText();
        out.push(tag.startsWith("!") ? `<${tag}>` : escapeText(`<${tag}>`));
      }
      continue;
    }
    const [, close = "", nameRaw = "", attrs = "", selfClose = ""] = m;
    const name = nameRaw.toLowerCase();
    if (drop !== null) {
      if (close === "/" && name === drop) {
        drop = null;
        out.push(`</${name}>`);
      }
      continue;
    }
    flushText();
    if (close === "/") {
      if (name === "td" || name === "th") {
        if (table.inHead || name === "th") table.headers[table.col] = table.cell.trim();
        table.left = table.cell.trim();
      }
      if (name === "thead") table.inHead = false;
      if (name === "table")
        Object.assign(table, { headers: [], col: -1, row: -1, left: "", inHead: false });
      out.push(`</${name}>`);
      continue;
    }
    const kept = maskAttrs(name, attrs, r);
    if (kept === null) continue; // a hidden field: removed whole
    out.push(`<${name}${kept}${selfClose}>`);
    if (DROP_CONTENT.has(name) && selfClose === "") drop = name;
    if (name === "table")
      Object.assign(table, { headers: [], col: -1, row: -1, left: "", inHead: false });
    if (name === "thead") table.inHead = true;
    if (name === "tr") Object.assign(table, { row: table.row + 1, col: -1, left: "" });
    if (name === "td" || name === "th") Object.assign(table, { col: table.col + 1, cell: "" });
  }
  flushText();
  return mask(out.join(""));
}

/**
 * Masks one tag's attributes. Returns null to drop the tag: a hidden input. Removes every input
 * value, inline handlers, and `style` (it can hold `content:` text). Masks text and address attributes.
 */
function maskAttrs(tag: string, attrs: string, r: Redactor): string | null {
  const kept: string[] = [];
  let hidden = false;
  for (const a of attrs.matchAll(ATTR)) {
    const name = (a[1] ?? "").toLowerCase();
    const value = unescape(a[2] ?? a[3] ?? a[4] ?? "");
    if (name === "type" && tag === "input" && value.toLowerCase() === "hidden") hidden = true;
    if (name.startsWith("on") || name === "value" || name === "style" || name === "srcdoc")
      continue;
    if (name.startsWith("data-")) continue;
    if (TEXT_ATTRS.has(name) || ADDRESS_ATTRS.has(name)) {
      if (/^\s*javascript:/i.test(value)) continue;
      kept.push(` ${name}="${escapeAttr(r.text(value))}"`);
      continue;
    }
    kept.push(
      a[2] === undefined && a[3] === undefined && a[4] === undefined
        ? ` ${name}`
        : ` ${name}="${escapeAttr(r.text(value))}"`,
    );
  }
  return hidden ? null : kept.join("");
}

/** A line of the accessibility snapshot: `- role "name"`, `- role "name": value`, or `- text: …`. */
const A11Y_LINE = /^(\s*-\s+)([a-zA-Z/]+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/;

/** Roles whose line may carry a field value after the name. The value is dropped (section 3 §7.6). */
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);

/** Masks an accessibility snapshot: names and text pass the text rules; field values are dropped. */
export function maskA11y(text: string, r: Redactor): Masked<string> {
  const lines = text.split("\n").map((line) => {
    const m = A11Y_LINE.exec(line);
    if (m === null) return r.text(line);
    const [, lead = "", role = "", name, rest = ""] = m;
    const named = name === undefined ? "" : ` "${r.text(name)}"`;
    if (VALUE_ROLES.has(role)) return `${lead}${role}${named}${rest.startsWith(":") ? ":" : ""}`;
    return `${lead}${role}${named}${r.text(rest)}`;
  });
  return mask(lines.join("\n"));
}
