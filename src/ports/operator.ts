// The operator port: carries intervention requests to humans, and their answers back.
// Follows design section 9 §5.4.
import type { Masked } from "./masked.js";
import type { Opaque } from "./opaque.js";
import type { Outcome } from "./outcome.js";

/** One intervention request. Section 7 §13. M07. */
export type Intervention = Opaque<"Intervention">;

/** A handle to one open intervention. */
export type Handle = Opaque<"OperatorHandle">;

/** What a human did: claim, release, decide, or answer a dialog (section 9 §5.4). */
export type OperatorEvent =
  | { kind: "claimed"; staff: string; implicit: boolean }
  | { kind: "released"; staff: string; note?: string }
  | { kind: "decided"; staff: string; decision: string; outcome?: string; note?: string }
  | { kind: "dialog"; staff: string; answer: "accept" | "dismiss" };

/** The operator port. Deadlines use the clock port in the core; adapters never time out a human. */
export interface OperatorPort {
  /** Opens a request. */
  open(req: Masked<Intervention>, signal?: AbortSignal): Promise<Outcome<Handle, "write_failed">>;
  /** The next claim, release, decision, or dialog answer. The core owns the deadline. */
  next(h: Handle, signal?: AbortSignal): Promise<Outcome<OperatorEvent, "closed">>;
  /** Closes a request. */
  close(h: Handle, how: "resolved" | "timed_out" | "run_ended"): Promise<void>;
}
