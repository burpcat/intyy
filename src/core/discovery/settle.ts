// Settling before each observation: wait until the page stops changing, capped at 10 seconds.
// Follows design section 6 §10.1 step 1 and section 7 §2.1 (wait for state, never for time).
import type { Clock } from "../../ports/clock.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { Eyes, Observation } from "../../ports/surface.js";

/** How long discovery waits for a page to settle, at most (section 6 §10.1). */
export const SETTLE_CAP_MS = 10_000;
/** The gap between two looks. */
const POLL_MS = 250;

/** What must stay the same between two looks: address, box, and every element's state. */
function stateKey(o: Observation): string {
  return JSON.stringify([
    o.url,
    o.dialog,
    o.popups,
    o.elements.map((e) => [e.ref, e.clues.name, e.clues.text, e.field, e.enabled, e.box]),
  ]);
}

/**
 * Looks until two looks in a row agree, then returns the last one. At the cap it returns the
 * newest look anyway: discovery goes on, and the LLM sees what is there.
 * ponytail: a still screen, not the network's quiet; add request events if pages flicker.
 */
export async function settle(
  eyes: Eyes,
  clock: Clock,
  signal?: AbortSignal,
): Promise<Outcome<Observation, "page_gone">> {
  const start = clock.now().getTime();
  let prev = await eyes.observe(signal);
  if (!prev.ok) return fail("page_gone");
  for (;;) {
    if (clock.now().getTime() - start >= SETTLE_CAP_MS) return ok(prev.value);
    await clock.after(POLL_MS, signal);
    const cur = await eyes.observe(signal);
    if (!cur.ok) return fail("page_gone");
    if (stateKey(cur.value) === stateKey(prev.value)) return ok(cur.value);
    prev = cur;
  }
}
