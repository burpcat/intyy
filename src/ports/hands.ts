// The surface port, hands half: act on one live session. Only the gate, the Playwright adapter,
// and fakes may import this file. Follows design section 9 §5.2 and build plan section 10 §5.3.
import type { Outcome } from "./outcome.js";
import type { Secret } from "./secret.js";
import type { ElementRef, Eyes, LeaseToken, SessionConfig, SurfaceFactory } from "./surface.js";

/**
 * One resolved action: what to do, and to which element (section 9 §5.2). The core has already
 * voted on the target. A secret arrives as an opaque value; only the hands open it (section 4 §8.5).
 * `read` is not here: reading is the eyes' job.
 */
export type ResolvedAction =
  | { type: "navigate"; url: string }
  | {
      type: "click";
      target: ElementRef;
      /** Caps the browser's readiness wait (visible, stable, enabled, not covered): 5 s
       * normally, 2 s on the commit step (section 7 §7.1). Undefined keeps the old default. */
      readinessTimeoutMs?: number;
    }
  | { type: "type"; target: ElementRef; text: string | Secret }
  | { type: "select"; target: ElementRef; option: string }
  | { type: "set_checked"; target: ElementRef; checked: boolean }
  | { type: "press"; key: string; target: ElementRef | null }
  | { type: "scroll"; direction: "up" | "down" };

/** What an action did. A transport failure is part of the answer, not a thrown error (section 7 §7.2). */
export type ActResult = {
  dispatched: true | false | "unknown";
  transport?: "connection_closed" | "browser_error_page" | "navigation_timeout";
};

/** The hands. The gate is the only module that receives them (section 9 §5.2). */
export interface Hands {
  /** Performs one resolved action. */
  act(
    a: ResolvedAction,
    lease: LeaseToken,
    signal?: AbortSignal,
  ): Promise<Outcome<ActResult, "stale_element">>;
  /**
   * Drops the session's cookies, so the app sees a new visitor; the window stays open. For a
   * sign-in during the task (owner decision, 2026-10-02): an app may keep serving its
   * session-expired page to the old cookie. Optional: a fake with no cookies has nothing to drop.
   */
  clearCookies?(signal?: AbortSignal): Promise<void>;
}

/** The real shape behind a SurfaceFactory. Opening it yields eyes and hands. */
export interface SurfaceSession {
  /** Opens a fresh session with the network guard already set. */
  open(
    cfg: SessionConfig,
    signal?: AbortSignal,
  ): Promise<Outcome<{ eyes: Eyes; hands: Hands }, "browser_failed" | "unreachable">>;
  /** Closes the session. */
  close(): Promise<void>;
}

/** Hides a session behind the opaque factory. Why a cast: the brand has no runtime form (build plan §5.3). */
export const toFactory = (s: SurfaceSession): SurfaceFactory => s as unknown as SurfaceFactory;

/** Opens the factory back into its session. Only the gate calls this. */
export const fromFactory = (f: SurfaceFactory): SurfaceSession => f as unknown as SurfaceSession;
