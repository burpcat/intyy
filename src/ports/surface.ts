// The surface port, eyes half: perceive one live session. Anyone may import this file.
// Follows design section 9 §5.2 and build plan section 10 §5.3 (the unopened factory).
import type { Opaque } from "./opaque.js";
import type { Outcome } from "./outcome.js";

/** An unopened surface. Other modules can pass it on. Only the gate can open it (build plan §5.3). */
export type SurfaceFactory = Opaque<"SurfaceFactory">;

/** One screen observation: path, active page, pop-ups, elements, dialogs, field state. Section 7 §6.1, §9. M02. */
export type Observation = Opaque<"Observation">;

/** Raw PNG bytes. The core masks them before they reach any store. */
export type Png = Opaque<"Png">;

/** A reference to one element. Valid until the next page change. Section 9 §5.2. M02. */
export type ElementRef = Opaque<"ElementRef">;

/**
 * A role group: roles that stand in for each other (section 7 §6.1). A stripped button may lose
 * its `button` role but stays `button_like`. `navigation` is a link to a plain path, a tab, or a tree item.
 */
export type RoleGroup =
  "button_like" | "text_entry" | "choice" | "check" | "navigation" | "container";

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

/** The browser viewport size. Section 7. M02. */
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

/** Every event kind the eyes report (section 9 §5.2, `SurfaceEvent` table). */
export type SurfaceEventKind =
  | "navigation_started"
  | "navigation_done"
  | "request_started"
  | "request_done"
  | "page_changed"
  | "dialog_opened"
  | "dialog_closed"
  | "popup_opened"
  | "popup_closed"
  | "human_input"
  | "connection_closed"
  | "browser_error_page"
  | "network_blocked";

/** One surface event. M02 adds the fields each kind carries. */
export type SurfaceEvent = { readonly kind: SurfaceEventKind };

/** The eyes: observe, capture, and listen. Given to the engine, watchers, recorder, and scorer (section 9 §5.2). */
export interface Eyes {
  /** Every element of the active page and its frames, with clues and state. */
  observe(signal?: AbortSignal): Promise<Outcome<Observation, "page_gone">>;
  /** A raw screenshot. The core masks it. */
  screenshot(signal?: AbortSignal): Promise<Outcome<Png, "page_gone">>;
  /** Raw DOM and accessibility snapshots. The core masks them. */
  snapshots(signal?: AbortSignal): Promise<Outcome<{ dom: string; a11y: string }, "page_gone">>;
  /** A raw image crop of one element. */
  crop(el: ElementRef, signal?: AbortSignal): Promise<Outcome<Png, "stale_element">>;
  /** Navigation, requests, page changes, dialogs, pop-ups, human input, transport trouble. */
  events(signal?: AbortSignal): AsyncIterable<SurfaceEvent>;
}
