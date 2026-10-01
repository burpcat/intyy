// One line of a key's `live.jsonl`: one real run of the key, classified. Append only.
// Follows design section 8 §5.5 (live lines) and §12.1 (which runs count).
import { z } from "zod";
import { Sha256Hash } from "./canonical.js";
import { RunId } from "./ids.js";

/** How a live run counts (section 8 §12.1). Only the first three enter the live score. */
export const LiveClass = z.enum(["clean", "assisted", "recipe_failure", "app_failure", "not_counted"]);

/** A live class. */
export type LiveClass = z.infer<typeof LiveClass>;

/** The classes that enter the live score: clean, assisted, and recipe failures (section 8 §12.3). */
export const COUNTED_CLASSES: readonly LiveClass[] = ["clean", "assisted", "recipe_failure"];

/** Facts a live run ran under (section 8 §5.5, `under`). `null`: not known. */
export const LiveUnder = z
  .object({
    engine: z.string().min(1),
    handler_set: Sha256Hash.nullable(),
    jev: z.string().min(1).nullable(),
  })
  .strict();

/** What a live run ran under. */
export type LiveUnder = z.infer<typeof LiveUnder>;

/** One live line (section 8 §5.5). */
export const LiveLine = z
  .object({
    run_id: RunId,
    /** When the run ended. */
    at: z.iso.datetime(),
    /** `task`; `prelude` (a session key inside a task run); `check` (a reconciliation child). */
    as: z.enum(["task", "prelude", "check"]),
    mode: z.enum(["supervised", "unattended"]),
    class: LiveClass,
    code: z.string().min(1).nullable(),
    step: z.string().min(1).nullable(),
    under: LiveUnder,
    /** Winner margin per target voted in this run (the lowest, when a target voted twice). */
    margins: z.record(z.string().min(1), z.number()),
    /** Per target, the clues that differed. Names only: the run log holds no observed values (section 8 §13.4). */
    differing: z.record(z.string().min(1), z.array(z.string().min(1))),
    /** Clean time in ms per step, for the `timeout_pressure` alert (section 8 §12.4). */
    step_ms: z.record(z.string().min(1), z.number().int().nonnegative()),
  })
  .strict();

/** One live line. */
export type LiveLine = z.infer<typeof LiveLine>;
