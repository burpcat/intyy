// Condition waits and the outcome race: replay's screen-polling waits.
// Follows design section 7 §2.1 (wait for state, never for time), §5.2 (condition waits),
// §5.3 (the outcome race).
import type { Clock } from "../../ports/clock.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { Eyes, Observation } from "../../ports/surface.js";
import { fromObservation, type ScreenView } from "../targets/screen.js";
import type { Likenesses } from "../targets/picture.js";
import { vote } from "../targets/vote.js";
import { evaluate, imageTargetsOf, type AnyCheck, type ConditionAnswer, type EvalCtx } from "../targets/evaluate.js";

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
  step: (screen: ScreenView, o: Observation) => Promise<{ done: boolean; value: R }>,
  signal?: AbortSignal,
): Promise<Outcome<R, "page_gone">> {
  const start = clock.now().getTime();
  let last: R | undefined;
  for (;;) {
    const o = await eyes.observe(signal);
    if (o.ok) {
      const r = await step(fromObservation(o.value), o.value);
      last = r.value;
      if (r.done) return ok(r.value);
    }
    if (clock.now().getTime() - start >= timeoutMs) {
      return last === undefined ? fail("page_gone") : ok(last);
    }
    await clock.after(POLL_MS, signal);
  }
}

/**
 * `ctx` with likenesses measured on `o`, or `ctx` itself when `check` is already `true` without
 * them, nothing can measure, or no target it uses has an image clue. Why only then: a look is
 * cheap and a crop is not, so a normal page pays nothing (section 7 §6.3, §6.9).
 */
async function withPictures(checks: readonly AnyCheck[], screen: ScreenView, o: Observation, ctx: EvalCtx): Promise<EvalCtx> {
  if (ctx.measure === undefined) return ctx;
  const ids = new Set<string>();
  for (const c of checks) if (evaluate(c, screen, ctx) !== "true") imageTargetsOf(c, ctx, ids);
  // Only a target a picture could still decide: no winner now, but a winner if every crop
  // matched. A loading page, a normal page, and a page without the element all skip the crops.
  const perfect = new Map(screen.elements.map((e) => [e.id, 1]));
  const optimistic: Likenesses = new Map([...ctx.targets.keys()].map((id) => [id, perfect]));
  const open = [...ids].filter((id) => {
    const t = ctx.targets.get(id);
    if (t === undefined || vote(t, screen, ctx.targets, ctx.refs).kind !== "not_found") return false;
    return vote(t, screen, ctx.targets, ctx.refs, optimistic).kind === "winner";
  });
  if (open.length === 0) return ctx;
  return { ...ctx, likenesses: await ctx.measure(o, open) };
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
    async (screen, o) => {
      const answer = evaluate(check, screen, await withPictures([check], screen, o, ctx));
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
    async (screen, look): Promise<{ done: boolean; value: RaceResult }> => {
      const seen = await withPictures([checkpoint, ...outcomes.map((o) => o.condition)], screen, look, ctx);
      const checkpointTrue = evaluate(checkpoint, screen, seen) === "true";
      const won = outcomes.find((o) => evaluate(o.condition, screen, seen) === "true");
      if (won !== undefined) {
        return { done: true, value: { winner: "outcome", code: won.code, overlap: checkpointTrue, screen } };
      }
      if (checkpointTrue) return { done: true, value: { winner: "checkpoint", screen } };
      return { done: false, value: { winner: "timeout", screen } };
    },
    signal,
  );
}
