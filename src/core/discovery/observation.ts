// The observation builder: the masked element list, fresh element IDs, and the history lines the
// discovery LLM sees each turn. Follows design section 6 §8.1 (parts of a turn), §8.2 (element
// list), §8.3 (element IDs), §8.5 (history), §13.2 (visible label), and section 4 §10 (the LLM's view).
import type { Masked } from "../../ports/masked.js";
import type { ElementRef, Observation, SurfaceElement } from "../../ports/surface.js";
import { indent, masked, quoteScreen } from "../safety/redaction/compose.js";
import type { Redactor } from "../safety/redaction/redactor.js";
import { visibleLabel } from "../surface/visible-label.js";

/** The most elements one list shows (section 6 §8.2). */
export const MAX_ELEMENTS = 150;
/** Rows a table keeps once the list is over the cap. */
export const ROWS_KEPT = 10;
/** The most history lines one turn shows (section 6 §8.5). */
export const MAX_HISTORY = 40;

/** One screen as the LLM sees it. `ids` maps this turn's IDs, like `e3`, to live refs. */
export type ScreenView = {
  location: Masked<string>;
  title: Masked<string>;
  /** The element list, one element per line, nested with braces. */
  list: Masked<string>;
  ids: ReadonlyMap<string, ElementRef>;
  /** The live element behind each ID. */
  elements: ReadonlyMap<string, SurfaceElement>;
  /** The visible label per ID, raw. The fingerprint needs it (section 6 §13.1). */
  labels: ReadonlyMap<string, string>;
};

/** Roles that hold table rows. */
const TABLES = new Set(["table", "grid", "treegrid"]);

/** The field's label: by layout first (section 6 §13.2), else its markup label. */
function labelOf(el: SurfaceElement, all: readonly SurfaceElement[]): string | undefined {
  return visibleLabel(el, all) ?? el.clues.label;
}

/** Masks one text by the label rule when a sensitive label sits beside it (section 4 §9.7). */
function maskBeside(r: Redactor, text: string, el: SurfaceElement, label?: string): Masked<string> {
  const beside = [label, el.context?.column, el.context?.left].find(
    (l): l is string => l !== undefined && r.sensitiveLabel(l),
  );
  return beside === undefined ? r.text(text) : r.text(text, { label: beside });
}

/** The `value:` part of a field line. Secrets and password boxes never show (section 4 §8.6). */
function valuePart(r: Redactor, el: SurfaceElement, label?: string): Masked<string> {
  const f = el.field;
  if (f === undefined || f.kind === "check") return masked``;
  if (f.filled === true || (f.kind === "password" && (f.value ?? "") !== ""))
    return masked` value:"${r.secretField()}"`;
  if ((f.value ?? "") === "") return masked``;
  return masked` value:"${quoteScreen(maskBeside(r, f.value ?? "", el, label))}"`;
}

/** The state words a line shows (section 6 §8.2). */
function statePart(el: SurfaceElement): Masked<string> {
  const off = el.enabled ? masked`` : masked` disabled`;
  const on = el.field?.kind === "check" && el.field.checked === true ? masked` checked` : masked``;
  return masked`${off}${on}`;
}

/** One descendant's raw text and its masked form, where the two differ. */
type Part = { raw: string; masked: Masked<string> };

/**
 * Masks a parent's name, such as a row's joined cell text. Each descendant's text that its own
 * context masks, like a cell under "Name", keeps that mask inside the parent too. Why: the
 * parent has no column header, so the label rule alone would leave the name raw (section 4 §9.7).
 */
function maskComposite(
  r: Redactor,
  raw: string,
  el: SurfaceElement,
  parts: readonly Part[],
): Masked<string> {
  // Why two kinds: a masked piece is never masked again (section 4 §9.5).
  type Piece = { raw: string } | { done: Masked<string> };
  let pieces: Piece[] = [{ raw }];
  for (const p of [...parts].sort((a, b) => b.raw.length - a.raw.length)) {
    pieces = pieces.flatMap((piece): Piece[] => {
      if (!("raw" in piece) || !piece.raw.includes(p.raw)) return [piece];
      return piece.raw
        .split(p.raw)
        .flatMap((text, i): Piece[] =>
          i === 0 ? [{ raw: text }] : [{ done: p.masked }, { raw: text }],
        );
    });
  }
  return pieces
    .map((piece) => ("done" in piece ? piece.done : maskBeside(r, piece.raw, el)))
    .reduce((a, b) => masked`${a}${b}`, masked``);
}

/** The masked texts of every descendant whose own context changes it. */
function partsUnder(
  r: Redactor,
  el: SurfaceElement,
  kids: Map<ElementRef | null, SurfaceElement[]>,
): Part[] {
  const out: Part[] = [];
  const visit = (e: SurfaceElement): void => {
    for (const k of kids.get(e.ref) ?? []) {
      const raw = (k.clues.text ?? k.clues.name ?? "").trim();
      const m = raw === "" ? null : maskBeside(r, raw, k);
      if (m !== null && m !== raw) out.push({ raw, masked: m });
      visit(k);
    }
  };
  visit(el);
  return out;
}

/** One element's own line, after its ID. `parts` are its descendants' masked texts. */
function lineOf(
  r: Redactor,
  el: SurfaceElement,
  label: string | undefined,
  parts: readonly Part[],
): Masked<string> {
  const role = r.text(/^[a-z]+$/.test(el.role) ? el.role : "generic");
  const raw = el.clues.name ?? el.clues.text;
  const control = el.roleGroup !== "container";
  let name: Masked<string>;
  if (raw !== undefined && raw.trim() !== "") {
    // Why: a field's name is its label, not a value, so only a cell's header or left cell applies.
    const text = el.field === undefined ? maskComposite(r, raw, el, parts) : r.text(raw);
    name = masked` "${quoteScreen(text)}"`;
  } else if (control && label === undefined) {
    // Why: a stripped button has no words; the picture is the only clue (section 6 §8.4).
    name = el.roleGroup === "button_like" ? masked` (no name) image` : masked` (no name)`;
  } else {
    name = masked``;
  }
  const showLabel = label !== undefined && label !== raw;
  const labelPart = showLabel ? masked` label:"${quoteScreen(r.text(label))}"` : masked``;
  return masked`${role}${name}${labelPart}${valuePart(r, el, label)}${statePart(el)}`;
}

/** Children per parent, in page order. A parent missing from the list makes a top element. */
function childrenOf(elements: readonly SurfaceElement[]): Map<ElementRef | null, SurfaceElement[]> {
  const known = new Set(elements.map((e) => e.ref));
  const out = new Map<ElementRef | null, SurfaceElement[]>();
  for (const e of elements) {
    const key = e.parent !== undefined && known.has(e.parent) ? e.parent : null;
    out.set(key, [...(out.get(key) ?? []), e]);
  }
  return out;
}

/** True when an element earns a line: a control, a named or text element, or a holder of one. */
function keepSet(kids: Map<ElementRef | null, SurfaceElement[]>): Set<ElementRef> {
  const keep = new Set<ElementRef>();
  const visit = (e: SurfaceElement): boolean => {
    let any = false;
    for (const k of kids.get(e.ref) ?? []) any = visit(k) || any;
    const words = (e.clues.name ?? e.clues.text ?? "").trim() !== "";
    const mine = e.roleGroup !== "container" || e.field !== undefined || words || any;
    if (mine) keep.add(e.ref);
    return mine;
  };
  for (const top of kids.get(null) ?? []) visit(top);
  return keep;
}

/** Rows to fold once the list is over the cap: every row past the tenth, per table. */
function foldRows(
  kids: Map<ElementRef | null, SurfaceElement[]>,
  keep: Set<ElementRef>,
): { dropped: Set<ElementRef>; after: Map<ElementRef, number> } {
  const dropped = new Set<ElementRef>();
  const after = new Map<ElementRef, number>();
  const rowsUnder = (e: SurfaceElement, out: SurfaceElement[]): void => {
    for (const k of kids.get(e.ref) ?? []) {
      if (k.role === "row") out.push(k);
      else if (!TABLES.has(k.role)) rowsUnder(k, out);
    }
  };
  const visit = (e: SurfaceElement): void => {
    if (TABLES.has(e.role)) {
      const rows: SurfaceElement[] = [];
      rowsUnder(e, rows);
      const kept = rows.filter((row) => keep.has(row.ref));
      const last = kept[ROWS_KEPT - 1];
      if (kept.length > ROWS_KEPT && last !== undefined) {
        for (const row of kept.slice(ROWS_KEPT)) dropped.add(row.ref);
        after.set(last.ref, kept.length - ROWS_KEPT);
      }
    }
    for (const k of kids.get(e.ref) ?? []) visit(k);
  };
  for (const top of kids.get(null) ?? []) visit(top);
  return { dropped, after };
}

/** How many elements `keep` holds that no dropped row holds. */
function countKept(
  kids: Map<ElementRef | null, SurfaceElement[]>,
  keep: Set<ElementRef>,
  dropped: Set<ElementRef>,
): number {
  let n = 0;
  const visit = (e: SurfaceElement): void => {
    if (!keep.has(e.ref) || dropped.has(e.ref)) return;
    n += 1;
    for (const k of kids.get(e.ref) ?? []) visit(k);
  };
  for (const top of kids.get(null) ?? []) visit(top);
  return n;
}

/**
 * Builds the masked screen for one turn (section 6 §8.2, §8.3). IDs count from `e1` in page
 * order, fresh every turn. Over {@link MAX_ELEMENTS}, rows past the tenth in each table fold
 * into one line, then the list stops at the cap.
 */
export function buildScreen(o: Observation, r: Redactor): ScreenView {
  const kids = childrenOf(o.elements);
  const keep = keepSet(kids);
  let fold = { dropped: new Set<ElementRef>(), after: new Map<ElementRef, number>() };
  if (countKept(kids, keep, fold.dropped) > MAX_ELEMENTS) fold = foldRows(kids, keep);
  const total = countKept(kids, keep, fold.dropped);

  const lines: Masked<string>[] = [];
  const ids = new Map<string, ElementRef>();
  const elements = new Map<string, SurfaceElement>();
  const labels = new Map<string, string>();
  const walk = (e: SurfaceElement, depth: number): void => {
    if (!keep.has(e.ref) || fold.dropped.has(e.ref) || ids.size >= MAX_ELEMENTS) return;
    const id = `e${String(ids.size + 1)}`;
    ids.set(id, e.ref);
    elements.set(id, e);
    const label = labelOf(e, o.elements);
    if (label !== undefined) labels.set(id, label);
    const inner = (kids.get(e.ref) ?? []).filter(
      (k) => keep.has(k.ref) && !fold.dropped.has(k.ref),
    );
    const head = masked`e${ids.size} ${lineOf(r, e, label, partsUnder(r, e, kids))}`;
    if (inner.length === 0) {
      lines.push(indent(head, depth));
    } else {
      lines.push(indent(masked`${head} {`, depth));
      for (const k of inner) walk(k, depth + 1);
      lines.push(indent(masked`}`, depth));
    }
    const more = fold.after.get(e.ref);
    if (more !== undefined) lines.push(indent(masked`…and ${more} more rows`, depth));
  };
  for (const top of kids.get(null) ?? []) walk(top, 0);
  if (total > ids.size) lines.push(masked`…and ${total - ids.size} more elements`);

  return {
    location: r.text(locationOf(o.url)),
    title: quoteScreen(r.text(o.title)),
    list: masked`${lines}`,
    ids,
    elements,
    labels,
  };
}

/** The path and query of an address. The origin is fixed per run, so the LLM needs no host. */
export function locationOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * The history block: one line per past action, capped at {@link MAX_HISTORY} lines. Older lines
 * fold into a count (section 6 §8.5). Each line is already masked, like `t6 click e3 "Search" → ok`.
 */
export function historyText(lines: readonly Masked<string>[]): Masked<string> {
  if (lines.length <= MAX_HISTORY) return masked`${lines}`;
  const older = lines.length - MAX_HISTORY;
  return masked`(${older} earlier actions)\n${lines.slice(older)}`;
}
