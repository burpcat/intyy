// Watches surface events for human input: it tells the lease, and passes the input to capture.
// Follows design section 7 §12.4 (human input while the bot drives opens a takeover,
// `unexpected_human_input`; while nobody holds the lease it is an implicit claim), §14.3 (an input
// inside the bot's own window is the bot's) and section 4 §7.10 (humans during a takeover).
import type { HumanInput, SurfaceEvent } from "../../ports/surface.js";
import type { HumanInputEffect, Lease } from "./lease.js";

/** What the watcher needs from capture (`HumanCapture` fits it). */
export type CaptureHooks = {
  /** True when the input is the bot's own, so it is ignored (section 7 §14.3). */
  isBot(input: HumanInput): boolean;
  /** Logs a person's input (section 7 §14.1). */
  record(input: HumanInput): void;
};

/**
 * Reads `events` until it ends. Each person's `human_input` event goes to the lease; `onEffect`
 * hears what it did, so the engine can log the warning and close a waiting approval. Starts at
 * the call, so pass an iterable made before the engine's first action. An event with no `input`
 * (an adapter that cannot tell) always counts as a person's.
 */
export async function watchHumanInput(
  events: AsyncIterable<SurfaceEvent>,
  lease: Lease,
  implicitStaff: string | null,
  onEffect: (effect: HumanInputEffect) => void,
  capture?: CaptureHooks,
): Promise<void> {
  for await (const e of events) {
    if (e.kind !== "human_input") continue;
    if (e.input !== undefined && capture?.isBot(e.input) === true) continue;
    onEffect(lease.humanInput(implicitStaff));
    if (e.input !== undefined) capture?.record(e.input);
  }
}
