// Code that runs inside the page: it lists the elements of one frame, with role, role group,
// clues, state, and box. Follows design section 7 §6.1 (candidates and role groups), section 2
// §13.2 (clues), section 4 §8.6 (never read a secret-filled field), and §9.11 rule 4.
// Why a DOM reference: these functions run in the browser, so they need the DOM types.
/// <reference lib="dom" />
import type { Box, FieldState, RoleGroup } from "../../ports/surface.js";

/** One element as the page reports it. The adapter adds the ref and the path prefix. */
export type RawElement = {
  /** The element's ref, like `4:f0:17`. It stays on the element until the next page change. */
  ref: string;
  /** The ref of the nearest enclosing listed element in this frame. */
  parent?: string;
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

/**
 * What `collectElements` needs. `offset` moves frame boxes into top-document pixels. With `only`,
 * it describes that one element for a fingerprint (section 7 §14.1): no ref is set and no field
 * value is read, so a human's typing never enters the engine through a look. `only` stays in
 * the page: it is never sent through `evaluate`.
 */
export type CollectArg = {
  tag: string;
  offsetX: number;
  offsetY: number;
  secretKey: string;
  only?: Element;
};

/**
 * Lists the elements of the current frame. Each element gets a `data-intyy-ref` attribute, so
 * the adapter can find it again. An element keeps its ref for the whole generation, even when
 * the page adds or removes other elements. Runs in the page: it may use no outside names.
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
      if (arg.only !== undefined) return { kind: "choice" };
      const shown = el.selectedOptions[0];
      return { kind: "choice", value: clean(shown?.textContent) ?? "" };
    }
    if (role === null || !["textbox", "searchbox", "spinbutton"].includes(role)) return undefined;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return undefined;
    const kind = el instanceof HTMLInputElement && el.type === "password" ? "password" : "text";
    // Why: section 7 §14.2, a fingerprint never reads a field's value. The type event reads a
    // non-password value on its own.
    if (arg.only !== undefined) return { kind };
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
  // Why: a ref must never move to another element. A list position would shift when a script
  // adds a row, so each element keeps its own number, counted per frame (section 9 §5.2).
  const counter = window as unknown as { __intyyNextRef?: number };
  const listed = new Map<Element, string>();
  const refFor = (el: Element): string => {
    if (arg.only !== undefined) return "";
    const prior = el.getAttribute("data-intyy-ref");
    if (prior !== null && prior.startsWith(`${arg.tag}:`)) return prior;
    const n = counter.__intyyNextRef ?? 0;
    counter.__intyyNextRef = n + 1;
    const ref = `${arg.tag}:${String(n)}`;
    el.setAttribute("data-intyy-ref", ref);
    return ref;
  };
  const parentOf = (el: Element): string | undefined => {
    for (let p = el.parentElement; p !== null; p = p.parentElement) {
      const ref = listed.get(p);
      if (ref !== undefined) return ref;
    }
    return undefined;
  };
  const scrollX = arg.offsetX === 0 && arg.offsetY === 0 ? window.scrollX : 0;
  const scrollY = arg.offsetX === 0 && arg.offsetY === 0 ? window.scrollY : 0;
  for (const el of arg.only !== undefined ? [arg.only] : document.body.querySelectorAll("*")) {
    const role = roleOf(el);
    if (role === null && !clickable(el) && !hasOwnText(el)) continue;
    if (["script", "style", "noscript", "option"].includes(el.tagName.toLowerCase())) continue;
    // Why: a tied label is its field's `label` clue. An untied one stays as plain text, so
    // section 6 §13.2 can find the visible label by layout when `KVFCU_DROP_LABELS` cuts the tie.
    if (el instanceof HTMLLabelElement && el.control !== null) continue;
    const style = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (r.width === 0 && r.height === 0) continue;

    const ref = refFor(el);
    const parent = parentOf(el);
    listed.set(el, ref);
    const label = labelOf(el);
    const e: RawElement = {
      ref,
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
    if (parent !== undefined) e.parent = parent;
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

/** What the capture script reports for one control: `RawElement` without refs or values. */
export type CapturedPrint = {
  role: string;
  roleGroup: RoleGroup;
  clues: { name?: string; label?: string; text?: string; path: string };
  tooltip?: string;
  href?: string;
  form?: { id: string; submits: boolean };
  box: Box | null;
  fieldKind?: "text" | "password" | "choice" | "check";
};

/**
 * Installs the human-input capture (design section 7 §14.1). It reports click, type (one per
 * field, at blur), select, set_checked, and press (Enter, Escape, Tab, F-keys) through the
 * `binding`. Each report carries a fingerprint taken at once, so a click that changes the page
 * still has its control. A password field's value is never read (section 7 §14.2). Only trusted
 * events count: a script's own synthetic events do not. `collect` is `collectElements`, passed in
 * so the fingerprint uses one set of rules. Runs in the page: it may use no outside names.
 */
export function installCapture(
  collect: (arg: CollectArg) => RawElement[],
  binding: string,
  secretKey: string,
): void {
  const w = window as unknown as Record<string, unknown>;
  if (w["__intyyCaptureOn"] === true) return;
  w["__intyyCaptureOn"] = true;
  const send = (payload: Record<string, unknown>): void => {
    const fn = w[binding];
    if (typeof fn !== "function") return;
    try {
      void Promise.resolve((fn as (p: unknown) => unknown)(payload)).catch(() => undefined);
    } catch {
      // Why: a page that is going away may refuse the call. Nothing else can be done.
    }
  };
  const topUrl = (): string => {
    try {
      return window.top?.location.href ?? location.href;
    } catch {
      return location.href;
    }
  };
  /** The frame's place in top-document pixels, as the eyes measure it. */
  const offset = (): { x: number; y: number } => {
    let x = 0;
    let y = 0;
    try {
      let win: Window = window;
      while (win.parent !== win) {
        const holder = win.frameElement;
        if (holder === null) break;
        const r = holder.getBoundingClientRect();
        x += r.x;
        y += r.y;
        win = win.parent;
      }
      if (win !== window) {
        x += win.scrollX;
        y += win.scrollY;
      }
    } catch {
      // Why: a frame from another host cannot be measured. Its boxes stay frame-relative.
    }
    return { x, y };
  };
  const INTERACTIVE = "button,a[href],input,select,textarea,summary,[role],[onclick],[tabindex]";
  const print = (target: EventTarget | null): CapturedPrint | null => {
    if (!(target instanceof Element)) return null;
    const at = offset();
    const start = target.closest(INTERACTIVE) ?? target;
    for (
      let e: Element | null = start;
      e !== null && e !== document.documentElement;
      e = e.parentElement
    ) {
      const [raw] = collect({ tag: "", offsetX: at.x, offsetY: at.y, secretKey, only: e });
      if (raw === undefined) continue;
      const out: CapturedPrint = {
        role: raw.role,
        roleGroup: raw.roleGroup,
        clues: { path: raw.path },
        box: raw.box,
      };
      if (raw.name !== undefined) out.clues.name = raw.name;
      if (raw.label !== undefined) out.clues.label = raw.label;
      if (raw.text !== undefined) out.clues.text = raw.text;
      if (raw.tooltip !== undefined) out.tooltip = raw.tooltip;
      if (raw.href !== undefined) out.href = raw.href;
      if (raw.form !== undefined) out.form = raw.form;
      if (raw.field !== undefined) out.fieldKind = raw.field.kind;
      return out;
    }
    return { role: "generic", roleGroup: "container", clues: { path: "" }, box: null };
  };

  const TEXTLESS = ["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color", "hidden"];
  const isTextField = (t: EventTarget | null): t is HTMLInputElement | HTMLTextAreaElement =>
    t instanceof HTMLTextAreaElement ||
    (t instanceof HTMLInputElement && !TEXTLESS.includes(t.type));
  /** Fields with typing not yet reported, and the time of the last keystroke in each. */
  const dirty = new Map<HTMLInputElement | HTMLTextAreaElement, number>();
  const report = (el: HTMLInputElement | HTMLTextAreaElement): void => {
    const at = dirty.get(el);
    if (at === undefined) return;
    dirty.delete(el);
    const target = print(el);
    if (target === null) return;
    // Why: section 7 §14.2, a password field's value is never read.
    const value = el instanceof HTMLInputElement && el.type === "password" ? null : el.value;
    send({ kind: "type", at, url: topUrl(), target, value });
  };
  const flush = (): void => {
    for (const el of [...dirty.keys()]) report(el);
  };

  window.addEventListener(
    "input",
    (e) => {
      if (e.isTrusted && isTextField(e.target)) dirty.set(e.target, Date.now());
    },
    true,
  );
  window.addEventListener("focusout", (e) => {
    if (isTextField(e.target)) report(e.target);
  }, true);
  window.addEventListener("pagehide", flush, true);
  window.addEventListener("submit", flush, true);
  /** When Enter last went down. Enter in a field makes the browser click the form's submit control. */
  let enterAt = 0;
  window.addEventListener(
    "click",
    (e) => {
      if (!e.isTrusted) return;
      // Why: that click is the Enter press's own effect, already reported as `press` with `submit`.
      if (e.detail === 0 && Date.now() - enterAt < 100) return;
      // Why: a checkbox or radio click is reported by its change event, as `set_checked`.
      if (e.target instanceof HTMLInputElement && (e.target.type === "checkbox" || e.target.type === "radio")) return;
      flush();
      const target = print(e.target);
      if (target !== null) send({ kind: "click", at: Date.now(), url: topUrl(), target });
    },
    true,
  );
  window.addEventListener(
    "change",
    (e) => {
      if (!e.isTrusted) return;
      const t = e.target;
      if (t instanceof HTMLSelectElement) {
        const target = print(t);
        const option = (t.selectedOptions[0]?.textContent ?? "").replace(/\s+/g, " ").trim();
        if (target !== null) send({ kind: "select", at: Date.now(), url: topUrl(), target, option });
      } else if (t instanceof HTMLInputElement && (t.type === "checkbox" || t.type === "radio")) {
        const target = print(t);
        if (target !== null) {
          send({ kind: "set_checked", at: Date.now(), url: topUrl(), target, checked: t.checked });
        }
      }
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.isTrusted || e.repeat) return;
      if (!(["Enter", "Escape", "Tab"].includes(e.key) || /^F\d{1,2}$/.test(e.key))) return;
      if (e.key === "Enter") enterAt = Date.now();
      flush();
      const target = print(e.target);
      let submit: CapturedPrint | null = null;
      // Why `?? null`: only form controls have a `form` property; any other element gives `undefined`.
      const form = (e.target as { form?: HTMLFormElement | null } | null)?.form ?? null;
      if (e.key === "Enter" && form !== null) {
        // Why: Enter in a field presses the form's first submit control (section 7 §14.4).
        const first = [...form.elements].find((c) =>
          c.matches("button[type=submit],button:not([type]),input[type=submit],input[type=image]"),
        );
        submit = first === undefined ? null : print(first);
      }
      send({ kind: "press", at: Date.now(), url: topUrl(), key: e.key, target, submit });
    },
    true,
  );
}
