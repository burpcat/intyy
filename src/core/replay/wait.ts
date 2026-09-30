// Condition waits and the outcome race: replay's screen-polling waits.
// Follows design section 7 §2.1 (wait for state, never for time), §5.2 (condition waits),
// §5.3 (the outcome race).
import type { Clock } from "../../ports/clock.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { Eyes } from "../../ports/surface.js";
import { fromObservation, type ScreenView } from "../targets/screen.js";
import { evaluate, type AnyCheck, type ConditionAnswer, type EvalCtx } from "../targets/evaluate.js";

/** How often a wait re-checks, at the slowest (section 7 §5.2: "at least every 200 ms"). */
const POLL_MS = 200;

/**
 * Looks at the screen until `step` says to stop, or `timeoutMs` passes (section 7 §5.2: check at
 * once, then at least every {@link POLL_MS}). A failed look does not end the wait: it is treated
 * as still loading, and the last good look's answer stands until a new one arrives. `page_gone`
 * is returned only when no look ever worked.
 */
async function pollScreen<R>(
  eyes: Eyes,
  clock: Clock,
  timeoutMs: number,
  step: (screen: ScreenView) => { done: boolean; value: R },
  signal?: AbortSignal,
): Promise<Outcome<R, "page_gone">> {
  const start = clock.now().getTime();
  let last: R | undefined;
  for (;;) {
    const o = await eyes.observe(signal);
    if (o.ok) {
      const r = step(fromObservation(o.value));
      last = r.value;
      if (r.done) return ok(r.value);
    }
    if (clock.now().getTime() - start >= timeoutMs) {
      return last === undefined ? fail("page_gone") : ok(last);
    }
    await clock.after(POLL_MS, signal);
  }
}

/** What a condition wait ends with: the answer it settled on, and the screen it read it from. */
export type ConditionWaitResult = { answer: ConditionAnswer; screen: ScreenView };

/**
 * Waits for one condition to answer `true` (section 7 §5.2). Only `true` stops the wait early
 * (section 2 §14.2, section 7 §2.2: unknown never passes); `false` or `unknown` at the timeout
 * are returned as is, for the caller to act on.
 */
export function waitForCondition(
  check: AnyCheck,
  eyes: Eyes,
  ctx: EvalCtx,
  timeoutMs: number,
  clock: Clock,
  signal?: AbortSignal,
): Promise<Outcome<ConditionWaitResult, "page_gone">> {
  return pollScreen(
    eyes,
    clock,
    timeoutMs,
    (screen) => {
      const answer = evaluate(check, screen, ctx);
      return { done: answer === "true", value: { answer, screen } };
    },
    signal,
  );
}

/** One step outcome the race checks alongside the checkpoint (section 2 §12.6, §15.1). */
export type RaceOutcome = { code: string; condition: AnyCheck };

/** How the outcome race ended (section 7 §5.3). */
export type RaceResult =
  | { winner: "checkpoint"; screen: ScreenView }
  | { winner: "outcome"; code: string; overlap: boolean; screen: ScreenView }
  | { winner: "timeout"; screen: ScreenView };

/**
 * Races a step's checkpoint against its declared outcomes (section 7 §5.3). The first condition
 * to answer `true` wins, so a quick "not found" outcome does not wait out the checkpoint's
 * timeout. When the checkpoint and an outcome are both `true` on the same look, the outcome
 * wins, and `overlap` marks it: the caller logs `checkpoint_outcome_overlap` (section 7 §5.3).
 */
export function raceCheckpointAndOutcomes(
  checkpoint: AnyCheck,
  outcomes: readonly RaceOutcome[],
  eyes: Eyes,
  ctx: EvalCtx,
  timeoutMs: number,
  clock: Clock,
  signal?: AbortSignal,
): Promise<Outcome<RaceResult, "page_gone">> {
  return pollScreen(
    eyes,
    clock,
    timeoutMs,
    (screen): { done: boolean; value: RaceResult } => {
      const checkpointTrue = evaluate(checkpoint, screen, ctx) === "true";
      const won = outcomes.find((o) => evaluate(o.condition, screen, ctx) === "true");
      if (won !== undefined) {
        return { done: true, value: { winner: "outcome", code: won.code, overlap: checkpointTrue, screen } };
      }
      if (checkpointTrue) return { done: true, value: { winner: "checkpoint", screen } };
      return { done: false, value: { winner: "timeout", screen } };
    },
    signal,
  );
}
