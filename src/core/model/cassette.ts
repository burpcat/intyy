// The planner cassette (`intyy.cassette/1.0`): a saved discovery run's masked turns and replies,
// for replay in CI with no model key. Follows design section 9 §16 ("Planner cassette") and the
// M03 spec (tasks 12, 13). Pictures are not kept: the element list is what must match.
import { z } from "zod";
import { RunId } from "./ids.js";

/** One saved turn: the message the model was sent, and the reply it gave. */
const CassetteTurn = z
  .object({
    message: z.string(),
    reply: z
      .object({
        call: z
          .object({ name: z.string().min(1), input: z.unknown() })
          .strict()
          .nullable(),
        model: z.string().min(1),
        usage: z
          .object({ input_tokens: z.number().int(), output_tokens: z.number().int() })
          .strict(),
      })
      .strict(),
  })
  .strict();

/** A cassette: where it came from, the system prompt's hash, and every turn in order. */
export const Cassette = z
  .object({
    schema: z.literal("intyy.cassette/1.0"),
    run_id: RunId,
    model: z.string().min(1),
    prompt: z.string().min(1),
    /** `sha256:` of the system prompt. A new prompt version cannot replay an old cassette. */
    system: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    turns: z.array(CassetteTurn).min(1),
  })
  .strict();

/** A cassette. */
export type Cassette = z.infer<typeof Cassette>;
