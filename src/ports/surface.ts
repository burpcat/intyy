// The surface port, eyes half: perceive one live session. Anyone may import this file.
// Follows design section 9 §5.2, section 7 §6.1 and §9 (candidates, dialogs, pop-ups), section 2
// §13.2 (clues), section 4 §6 (allowlist), and build plan section 10 §5.3 (the unopened factory).
import type { Opaque } from "./opaque.js";
import type { Outcome } from "./outcome.js";

/** An unopened surface. Other modules can pass it on. Only the gate can open it (build plan §5.3). */
export type SurfaceFactory = Opaque<"SurfaceFactory">;

/** Raw PNG bytes. The core masks them before they reach any store. */
export type Png = Uint8Array & Opaque<"Png">;

/** A reference to one element. Valid until the next page change (section 9 §5.2). */
export type ElementRef = Opaque<"ElementRef">;

/**
 * A role group: roles that stand in for each other (section 7 §6.1). A stripped button may lose
 * its `button` role but stays `button_like`. `navigation` is a link to a plain path, a tab, or a tree item.
 */
export type RoleGroup =
  "button_like" | "text_entry" | "choice" | "check" | "navigation" | "container";

/** A box in CSS pixels, measured from the top left of the document (section 2 §13.2, `region`). */
export type Box = { x: number; y: number; width: number; height: number };

/**
 * A field's state. A secret-filled field reports `filled: true` and never its value
 * (section 4 §8.6). `password` marks a masked input box (§8.5).
 */
export type FieldState = {
  kind: "text" | "password" | "choice" | "check";
  value?: string;
  filled?: true;
  checked?: boolean;
};

/**
 * One element the eyes see. Its text is raw: the core masks it before any write.
 * Clues follow section 2 §13.2. `path` starts with `window[popup]` in a pop-up, or
 * `native:dialog` for a browser dialog. Frames appear in the path as `frame[n]`.
 */
export type SurfaceElement = {
  ref: ElementRef;
  /**
   * The nearest enclosing element in the same observation. A frame's top elements sit under
   * its `iframe`; a native dialog's buttons sit under its box. Absent at the top.
   */
  parent?: ElementRef;
  role: string;
  roleGroup: RoleGroup;
  clues: { name?: string; label?: string; text?: string; path: string };
  /** The tooltip, one of the four places risk reads words from (section 4 §7.3). */
  tooltip?: string;
  /** A plain link's full address. Script links have none and are button-like. */
  href?: string;
  field?: FieldState;
  /** The form the control sits in, and whether a click on it submits that form (section 4 §7.5, C1). */
  form?: { id: string; submits: boolean };
  /** Label-rule sources 2 and 3 for a table cell: its column header and the cell to its left (section 4 §9.7). */
  context?: { column?: string; left?: string };
  /** Mask what you cannot read (section 4 §9.11 rule 4): a canvas, an embed, a frame from another host, or a large image. */
  unreadable?: true;
  enabled: boolean;
  box: Box | null;
};

/** A native browser box (section 7 §9.1). While one is open, only its elements appear. */
export type NativeDialog = { kind: "alert" | "confirm" | "prompt"; message: string };

/** One screen observation (section 9 §5.2): location, active page, pop-ups, a dialog, and elements. */
export type Observation = {
  /** The active page's full address. */
  url: string;
  /** The active page's title. Empty while a native box is open (section 6 §8.1). */
  title: string;
  /** The active page: the newest open window (section 7 §9.2). */
  page: "main" | "popup";
  /** How many pop-up windows are open. */
  popups: number;
  dialog: NativeDialog | null;
  viewport: Viewport;
  /** How far the active page is scrolled. A box minus this is its place in the screenshot. */
  scroll: { x: number; y: number };
  elements: readonly SurfaceElement[];
};

/** What a request loads (section 4 §6.8). A document is a page or a frame; a resource is anything else. */
export type RequestKind = "document" | "resource" | "websocket";

/** The allowlist's answer for one address. `irreversible`: arriving there changes data (section 4 §6.4). */
export type AllowVerdict =
  | { allowed: true; irreversible: boolean }
  | { allowed: false; rule: "allowlist.host" | "allowlist.path" | "allowlist.path_malformed" };

/**
 * The allowlist the network guard enforces: hosts × paths (section 4 §6.1). The core builds it,
 * so the path rules live once. The adapter only asks.
 */
export interface Allowlist {
  /** Checks one full address, like `http://127.0.0.1:8080/members/100107`. */
  check(url: string, kind: RequestKind): AllowVerdict;
  /** Pop-up windows may open inside the allowlist (section 4 §6.10). Else every pop-up is closed. */
  readonly popups: boolean;
}

/** The browser viewport size. Fixed per session, so boxes and crops stay comparable. */
export type Viewport = { width: number; height: number };

/** The token that proves who holds the screen: the engine or a human. Section 7 §12. M07. */
export type LeaseToken = Opaque<"LeaseToken">;

/** What `SurfaceSession.open` takes (section 9 §5.2). */
export type SessionConfig = {
  origin: string;
  allowlist: Allowlist;
  viewport: Viewport;
  locale: string;
  timeZone: string;
  visible: boolean;
};

/**
 * What the eyes know of a control a human acted on, taken as the event happens (section 7 §14.1):
 * role, clues, tooltip, link, form, box, and field kind. It never holds a field's value.
 */
export type ElementFingerprint = Pick<
  SurfaceElement,
  "role" | "roleGroup" | "clues" | "tooltip" | "href" | "form" | "box"
> & { fieldKind?: FieldState["kind"] };

/**
 * One human input (section 7 §14.1, section 9 §5.2). `at` is the time it happened, in ms since the
 * epoch. For `type` it is the last keystroke, not the blur. `url` is the page it happened on.
 * A typed value is raw and in memory only (section 7 §14.2); it is `null` for a password field,
 * which the page script never reads. The core masks it before any write.
 */
export type HumanInput = {
  at: number;
  url: string;
  action:
    | { type: "click"; target: ElementFingerprint }
    | { type: "type"; target: ElementFingerprint; value: string | null }
    | { type: "select"; target: ElementFingerprint; option: string }
    | { type: "set_checked"; target: ElementFingerprint; checked: boolean }
    /** `submit` is the form's default submit control, so Enter can be scored as its click. */
    | { type: "press"; key: string; target: ElementFingerprint | null; submit: ElementFingerprint | null }
    | { type: "navigate"; to: string };
};

/**
 * One surface event (section 9 §5.2, `SurfaceEvent` table). Addresses are raw; the core masks them.
 * `browser_blocked` covers the section 4 §6.10 features: a download, a file chooser, a pop-up.
 */
export type SurfaceEvent =
  | { kind: "navigation_started" | "navigation_done"; url: string }
  | {
      kind: "request_started" | "request_done";
      url: string;
      /**
       * `static`: an image, stylesheet, font, or media file. It never counts toward network
       * quiet (section 7 §5.1; docs/decisions.md, M05). `data`: everything else.
       */
      resource: "static" | "data";
    }
  | { kind: "page_changed" }
  | { kind: "dialog_opened"; dialog: NativeDialog }
  | { kind: "dialog_closed" }
  | { kind: "popup_opened"; url: string }
  | { kind: "popup_closed" }
  /**
   * A person touched the page (section 7 §12.4, §14). `input` says what they did. An adapter that
   * cannot tell still reports the touch, with no `input`.
   */
  | { kind: "human_input"; input?: HumanInput }
  | { kind: "connection_closed" }
  | { kind: "browser_error_page"; url: string }
  | {
      kind: "network_blocked";
      url: string;
      request: RequestKind;
      rule: "allowlist.host" | "allowlist.path" | "allowlist.path_malformed";
    }
  | { kind: "browser_blocked"; feature: "download" | "upload" | "popup" };

/** The eyes: observe, capture, and listen. Given to the engine, watchers, recorder, and scorer (section 9 §5.2). */
export interface Eyes {
  /** Every element of the active page and its frames, with clues and state. */
  observe(signal?: AbortSignal): Promise<Outcome<Observation, "page_gone">>;
  /**
   * A screenshot with solid boxes drawn over `masks` as the picture is taken (section 4 §9.11).
   * A stale mask fails the whole shot, so the caller saves nothing.
   */
  screenshot(
    masks: readonly ElementRef[],
    signal?: AbortSignal,
  ): Promise<Outcome<Png, "page_gone" | "stale_element">>;
  /** Raw DOM and accessibility snapshots. The core masks them. */
  snapshots(signal?: AbortSignal): Promise<Outcome<{ dom: string; a11y: string }, "page_gone">>;
  /** A raw image crop of one element. */
  crop(el: ElementRef, signal?: AbortSignal): Promise<Outcome<Png, "stale_element">>;
  /** Events from this call on: navigation, requests, dialogs, pop-ups, human input, trouble. */
  events(signal?: AbortSignal): AsyncIterable<SurfaceEvent>;
}
