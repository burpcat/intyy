// The surface port, hands half: act on one live session. Only the gate, the Playwright adapter,
// and fakes may import this file. Follows design section 9 §5.2 and build plan section 10 §5.3.
import type { Opaque } from "./opaque.js";
import type { Outcome } from "./outcome.js";
import type { Eyes, LeaseToken, SessionConfig, SurfaceFactory } from "./surface.js";

/** One resolved action: a target element and what to do. Secrets arrive as opaque values. Section 7. M02. */
export type ResolvedAction = Opaque<"ResolvedAction">;

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
