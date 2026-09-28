// Code that runs inside the page: it lists the elements of one frame, with role, role group,
// clues, state, and box. Follows design section 7 §6.1 (candidates and role groups), section 2
// §13.2 (clues), section 4 §8.6 (never read a secret-filled field), and §9.11 rule 4.
// Why a DOM reference: these functions run in the browser, so they need the DOM types.
/// <reference lib="dom" />
import type { Box, FieldState, RoleGroup } from "../../ports/surface.js";

/** One element as the page reports it. The adapter adds the ref and the path prefix. */
export type RawElement = {
  idx: number;
  role: string;
  roleGroup: RoleGroup;
  name?: string;
  label?: string;
  text?: string;
  tooltip?: string;
  href?: string;
  field?: FieldState;
  form?: { id: string; submits: boolean };
  context?: { column?: string; left?: string };
  unreadable?: true;
  enabled: boolean;
  box: Box | null;
  path: string;
};

/** What `collectElements` needs. `offset` moves frame boxes into top-document pixels. */
export type CollectArg = { tag: string; offsetX: number; offsetY: number; secretKey: string };

/**
 * Lists the elements of the current frame. Each element gets a `data-intyy-ref` attribute, so
 * the adapter can find it again. Runs in the page: it may use no outside names.
 */
export function collectElements(arg: CollectArg): RawElement[] {
  const secretFields = (window as unknown as Record<string, WeakSet<Element> | undefined>)[
    arg.secretKey
  ];
  const clean = (t: string | null | undefined): string | undefined => {
    const s = (t ?? "").replace(/\s+/g, " ").trim();
    return s === "" ? undefined : s.slice(0, 500);
  };
  const textOf = (el: Element): string | undefined =>
    clean(el instanceof HTMLElement ? el.innerText : el.textContent);
  const byIds = (ids: string | null): string | undefined =>
    clean(
      (ids ?? "")
        .split(/\s+/)
        .map((id) => (id === "" ? "" : (document.getElementById(id)?.textContent ?? "")))
        .join(" "),
    );

  /** The ARIA role: the `role` attribute, else the tag's own role. */
  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicit !== undefined && explicit !== "") return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "button") return "button";
    if (tag === "input") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "hidden") return null;
      if (type === "search") return "searchbox";
      if (type === "number") return "spinbutton";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") {
      const s = el as HTMLSelectElement;
      return s.multiple || s.size > 1 ? "listbox" : "combobox";
    }
    const tags: Record<string, string> = {
      img: "img",
      table: "table",
      tr: "row",
      td: "cell",
      th: "columnheader",
      li: "listitem",
      ul: "list",
      ol: "list",
      form: "form",
      dialog: "dialog",
      h1: "heading",
      h2: "heading",
      h3: "heading",
      h4: "heading",
      h5: "heading",
      h6: "heading",
      iframe: "iframe",
      frame: "iframe",
      canvas: "canvas",
      embed: "embed",
      object: "embed",
    };
    return tags[tag] ?? null;
  };

  /** A link that only runs script, like `javascript:post()`, is button-like (section 4 §7.4). */
  const plainHref = (el: Element): string | undefined => {
    if (!(el instanceof HTMLAnchorElement) || !el.hasAttribute("href")) return undefined;
    const raw = el.getAttribute("href") ?? "";
    if (raw.startsWith("#") || raw.trim().toLowerCase().startsWith("javascript:")) return undefined;
    return el.protocol === "http:" || el.protocol === "https:" ? el.href : undefined;
  };

  const clickable = (el: Element): boolean =>
    el.hasAttribute("onclick") || (el instanceof HTMLElement && el.tabIndex >= 0);

  /** The role group (section 7 §6.1). A clickable element with no clear role is button-like. */
  const groupOf = (el: Element, role: string | null): RoleGroup => {
    if (role === "link") return plainHref(el) === undefined ? "button_like" : "navigation";
    if (role === null || role === "img") return clickable(el) ? "button_like" : "container";
    if (["button", "menuitem", "menuitemcheckbox", "menuitemradio"].includes(role)) {
      return "button_like";
    }
    if (["textbox", "searchbox", "spinbutton"].includes(role)) return "text_entry";
    if (role === "combobox" || role === "listbox") return "choice";
    if (["checkbox", "radio", "switch"].includes(role)) return "check";
    if (role === "tab" || role === "treeitem") return "navigation";
    return "container";
  };

  /** The visible label beside a field: `<label for>`, a wrapping label, or `aria-labelledby`. */
  const labelOf = (el: Element): string | undefined => {
    const byAria = byIds(el.getAttribute("aria-labelledby"));
    if (byAria !== undefined) return byAria;
    // Why: only form fields have `labels`; other elements lack the property.
    const labels = "labels" in el ? (el as HTMLInputElement).labels : null;
    if (labels !== null && labels.length > 0) {
      return clean([...labels].map((l) => l.textContent).join(" "));
    }
    return undefined;
  };

  /** A short accessible name. Enough for clues; not the full ARIA name algorithm. */
  const nameOf = (
    el: Element,
    role: string | null,
    label: string | undefined,
  ): string | undefined => {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria !== undefined) return aria;
    if (label !== undefined) return label;
    if (el instanceof HTMLImageElement) return clean(el.alt) ?? clean(el.title);
    if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type)) {
      return clean(el.value) ?? clean(el.title);
    }
    if (el instanceof HTMLInputElement && el.type === "image")
      return clean(el.alt) ?? clean(el.title);
    if (role !== null && ["textbox", "searchbox", "combobox", "listbox"].includes(role)) {
      return clean(el.getAttribute("placeholder")) ?? clean(el.getAttribute("title"));
    }
    const inner = el.querySelector("img[alt]");
    return textOf(el) ?? clean(inner?.getAttribute("alt")) ?? clean(el.getAttribute("title"));
  };

  /** A field's state. A secret-filled field says `filled` and never its value (section 4 §8.6). */
  const fieldOf = (el: Element, role: string | null): FieldState | undefined => {
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      return { kind: "check", checked: el.checked };
    }
    if (el instanceof HTMLSelectElement) {
      const shown = el.selectedOptions[0];
      return { kind: "choice", value: clean(shown?.textContent) ?? "" };
    }
    if (role === null || !["textbox", "searchbox", "spinbutton"].includes(role)) return undefined;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return undefined;
    const kind = el instanceof HTMLInputElement && el.type === "password" ? "password" : "text";
    if (secretFields?.has(el) === true) return el.value === "" ? { kind } : { kind, filled: true };
    return { kind, value: el.value };
  };

  /** The form a control sits in, and whether a click on it submits that form (C1). */
  const formOf = (el: Element): { id: string; submits: boolean } | undefined => {
    const f = (el as HTMLInputElement).form as HTMLFormElement | null | undefined;
    if (f === null || f === undefined) return undefined;
    const id = f.id !== "" ? f.id : `form[${String([...document.forms].indexOf(f))}]`;
    const submits =
      (el instanceof HTMLButtonElement && el.type === "submit") ||
      (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "image"));
    return { id, submits };
  };

  /** Rule 4 of section 4 §9.11: a canvas, an embed, a frame from another host, or a large image. */
  const unreadable = (el: Element, r: DOMRect): boolean => {
    const tag = el.tagName.toLowerCase();
    if (tag === "canvas" || tag === "embed" || tag === "object") return true;
    if (tag === "img") return r.width > 64 || r.height > 64;
    if (tag === "iframe" || tag === "frame") {
      try {
        return (el as HTMLIFrameElement).contentDocument === null;
      } catch {
        return true;
      }
    }
    return false;
  };

  /** A DOM path like `body > form[0] > input[1]`: tag and index among same-tag siblings. */
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    for (
      let e: Element | null = el;
      e !== null && e !== document.documentElement;
      e = e.parentElement
    ) {
      const cur = e;
      const tag = cur.tagName.toLowerCase();
      const same =
        cur.parentElement === null
          ? [cur]
          : [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName);
      parts.unshift(tag === "body" ? "body" : `${tag}[${String(same.indexOf(cur))}]`);
    }
    return parts.join(" > ");
  };

  /** A cell's column header and the cell to its left: label-rule sources 2 and 3 (section 4 §9.7). */
  const cellContext = (el: Element): { column?: string; left?: string } | undefined => {
    if (!(el instanceof HTMLTableCellElement)) return undefined;
    const out: { column?: string; left?: string } = {};
    const table = el.closest("table");
    const headRow = table?.tHead?.rows[0] ?? table?.rows[0];
    const head = headRow?.cells[el.cellIndex];
    if (head !== undefined && head !== el && head.tagName === "TH") {
      const column = textOf(head);
      if (column !== undefined) out.column = column;
    }
    const prev = el.previousElementSibling;
    if (prev !== null) {
      const left = textOf(prev);
      if (left !== undefined) out.left = left;
    }
    return out.column === undefined && out.left === undefined ? undefined : out;
  };

  const hasOwnText = (el: Element): boolean =>
    [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "",
    );

  const out: RawElement[] = [];
  const scrollX = arg.offsetX === 0 && arg.offsetY === 0 ? window.scrollX : 0;
  const scrollY = arg.offsetX === 0 && arg.offsetY === 0 ? window.scrollY : 0;
  for (const el of document.body.querySelectorAll("*")) {
    const role = roleOf(el);
    if (role === null && !clickable(el) && !hasOwnText(el)) continue;
    if (["script", "style", "noscript", "option", "label"].includes(el.tagName.toLowerCase()))
      continue;
    const style = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (r.width === 0 && r.height === 0) continue;

    const idx = out.length;
    el.setAttribute("data-intyy-ref", `${arg.tag}:${String(idx)}`);
    const label = labelOf(el);
    const e: RawElement = {
      idx,
      role: role ?? "generic",
      roleGroup: groupOf(el, role),
      enabled: !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true",
      box: {
        x: r.x + scrollX + arg.offsetX,
        y: r.y + scrollY + arg.offsetY,
        width: r.width,
        height: r.height,
      },
      path: pathOf(el),
    };
    const name = nameOf(el, role, label);
    if (name !== undefined) e.name = name;
    if (label !== undefined) e.label = label;
    const field = fieldOf(el, role);
    if (field !== undefined) e.field = field;
    else {
      const text = textOf(el);
      if (text !== undefined) e.text = text;
    }
    const tooltip = clean(el.getAttribute("title"));
    if (tooltip !== undefined) e.tooltip = tooltip;
    const href = plainHref(el);
    if (href !== undefined) e.href = href;
    const form = formOf(el);
    if (form !== undefined) e.form = form;
    const context = cellContext(el);
    if (context !== undefined) e.context = context;
    if (unreadable(el, r)) e.unreadable = true;
    out.push(e);
  }
  return out;
}

/** Marks a field that received a secret, for the rest of the page's life (section 4 §8.6). Runs in the page. */
export function markSecretField(el: Element, secretKey: string): void {
  const w = window as unknown as Record<string, WeakSet<Element> | undefined>;
  const set = w[secretKey] ?? new WeakSet<Element>();
  set.add(el);
  w[secretKey] = set;
}

/**
 * Serializes the frame's DOM from a copy with every input value and textarea text removed
 * (section 3 §7.6). Why in the page: a secret-filled field's value never enters intyy (section 4 §2.6).
 * Runs in the page.
 */
export function serializeFrame(): string {
  const copy = document.documentElement.cloneNode(true) as HTMLElement;
  for (const el of copy.querySelectorAll("input")) el.removeAttribute("value");
  for (const el of copy.querySelectorAll("textarea")) el.textContent = "";
  for (const el of copy.querySelectorAll("option")) el.removeAttribute("selected");
  const doctype = document.doctype === null ? "" : `<!DOCTYPE ${document.doctype.name}>`;
  return `${doctype}${copy.outerHTML}`;
}
