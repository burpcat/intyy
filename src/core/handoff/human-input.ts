// Watches surface events for human input and tells the lease. Follows design section 7 §12.4
// (human input while the bot drives opens a takeover, `unexpected_human_input`; while nobody
// holds the lease it is an implicit claim) and section 4 §7.10 (humans during a takeover).
// Task 3 adds capture: the event will carry the action, and this watcher will log it.
import type { SurfaceEvent } from "../../ports/surface.js";
import type { HumanInputEffect, Lease } from "./lease.js";

/**
 * Reads `events` until it ends. Each `human_input` event goes to the lease; `onEffect` hears what
 * it did, so the engine can log the warning and close a waiting approval. Starts at the call, so
 * pass an iterable made before the engine's first action.
 */
export async function watchHumanInput(
  events: AsyncIterable<SurfaceEvent>,
  lease: Lease,
  implicitStaff: string | null,
  onEffect: (effect: HumanInputEffect) => void,
): Promise<void> {
  for await (const e of events) {
    if (e.kind !== "human_input") continue;
    onEffect(lease.humanInput(implicitStaff));
  }
}
