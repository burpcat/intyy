// The screen view: the plain shape the clue voter and the condition evaluator read. A live
// `Observation` maps to it now (M04 task 5); M05's replay engine, and the M04 recorder's saved-log
// review (task 7), build the same shape from their own capture, so the voter and evaluator never
// see a port type. Follows design section 7 §6 (clue voting) and section 2 §14 (conditions).
import type { Observation, RoleGroup } from "../../ports/surface.js";
import { locationOf } from "../discovery/observation.js";

/**
 * One screen element the voter and evaluator read. Any field may be absent when the source
 * capture lacks it (section 7 §6.4: a target clue the candidate lacks entirely leaves the vote).
 */
export type ScreenElement = {
  /** Stable within one {@link ScreenView} only. Used for `within` and `parent` lookups. */
  id: string;
  parent?: string;
  role: string;
  roleGroup: RoleGroup;
  name?: string;
  label?: string;
  text?: string;
  /** Position and size as fractions of the viewport (section 2 §13.2, `region`). */
  region?: { x: number; y: number; w: number; h: number };
  path: string;
  visible: boolean;
  enabled: boolean;
  checked?: boolean;
  selected?: boolean;
  /**
   * The field's raw value, only when the capture can see it (section 4 §8.6: a secret-filled
   * field never reports one). In memory only. A caller must never log, print, or write it.
   */
  fieldValue?: string;
  /**
   * True when the field holds a secret the eyes saw but never read (section 4 §8.6). Absent when
   * the capture does not say (an a11y snapshot). `fieldValue` is then absent too.
   */
  filled?: true;
};

/** One screen the voter and evaluator read (section 7 §6, section 2 §14). */
export type ScreenView = {
  /** The URL path and query, for a `location` check (section 2 §14.3, §14.4). */
  location: string;
  elements: readonly ScreenElement[];
};

/**
 * Maps one live {@link Observation} to a {@link ScreenView} (section 7 §6.1: every element of the
 * active page and its frames is a candidate). Every element the eyes report is already on screen:
 * the adapter drops CSS-hidden nodes before they reach `elements` (section 9 §5.2), and a native
 * dialog's elements have no box but are on screen too. So `visible` is always true here.
 */
export function fromObservation(o: Observation): ScreenView {
  const vw = o.viewport.width;
  const vh = o.viewport.height;
  const indexByRef = new Map(o.elements.map((el, i) => [el.ref, i]));
  const elements = o.elements.map((el, i): ScreenElement => {
    const out: ScreenElement = {
      id: String(i),
      role: el.role,
      roleGroup: el.roleGroup,
      path: el.clues.path,
      visible: true,
      enabled: el.enabled,
    };
    const parentIndex = el.parent === undefined ? undefined : indexByRef.get(el.parent);
    if (parentIndex !== undefined) out.parent = String(parentIndex);
    if (el.clues.name !== undefined) out.name = el.clues.name;
    if (el.clues.label !== undefined) out.label = el.clues.label;
    if (el.clues.text !== undefined) out.text = el.clues.text;
    if (el.box !== null) {
      out.region = {
        x: el.box.x / vw,
        y: el.box.y / vh,
        w: el.box.width / vw,
        h: el.box.height / vh,
      };
    }
    // ponytail: only "check" fields carry a checked flag today; "selected" (an option or row
    // marked current) has no port field yet. Add a clue when the port reports aria-selected.
    if (el.field?.kind === "check") out.checked = el.field.checked === true;
    if (el.field?.filled === true) out.filled = true;
    if (el.field !== undefined && el.field.filled !== true && el.field.value !== undefined) {
      out.fieldValue = el.field.value;
    }
    return out;
  });
  return { location: locationOf(o.url), elements };
}

/** `id`, plus every element under it by `parent` chains (section 7 §6.2, "then only its
 * descendants are candidates"). */
export function descendantsOf(screen: ScreenView, id: string): ReadonlySet<string> {
  const children = new Map<string, string[]>();
  for (const e of screen.elements) {
    if (e.parent !== undefined) children.set(e.parent, [...(children.get(e.parent) ?? []), e.id]);
  }
  const out = new Set<string>([id]);
  const stack = [id];
  for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
    for (const kid of children.get(cur) ?? []) {
      if (!out.has(kid)) {
        out.add(kid);
        stack.push(kid);
      }
    }
  }
  return out;
}

/** The element with this ID, or `undefined` when it does not exist on this screen. */
export function elementOf(screen: ScreenView, id: string): ScreenElement | undefined {
  return screen.elements.find((e) => e.id === id);
}
