// The `targets` block: named controls, each with a fingerprint of clues.
// Follows design section 2 §13.
import { z } from "zod";
import { SnakeId } from "./shared.js";

/** A position or size as a fraction of the window (section 2 §13.2, `region`). */
const Region = z
  .object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  })
  .strict();

/**
 * One target's fingerprint (section 2 §13.2). Any clue may be missing. `text` and `label` clues
 * may hold a `{input.*}` reference; the loader checks that (task 2).
 */
export const Clues = z
  .object({
    role: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    region: Region.optional(),
    image: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  })
  .strict();

/** One target's fingerprint. */
export type Clues = z.infer<typeof Clues>;

/** One `targets` entry: a named control (section 2 §13.1). */
export const Target = z
  .object({
    id: SnakeId,
    description: z.string().min(1),
    within: SnakeId.optional(),
    clues: Clues,
  })
  .strict();

/** One named control. */
export type Target = z.infer<typeof Target>;
