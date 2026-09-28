// The store index line (`intyy.index/1.0`) and the approval block it records.
// Follows design section 9 §6.4.
import { z } from "zod";

/** The approval stamp in a sealed file: staff ID and time. Example: `{ "by": "op_022", "at": "2026-09-26T08:00:00Z" }`. */
export const Approval = z.object({ by: z.string().min(1), at: z.iso.datetime() }).strict();

/** An approval stamp. */
export type Approval = z.infer<typeof Approval>;

/** One index line per seal or approval (section 9 §6.4). */
export const IndexLine = z
  .object({
    event: z.enum(["sealed", "approved"]),
    kind: z.string().min(1),
    id: z.string().min(1),
    rev: z.string().min(1),
    path: z.string().min(1),
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    by: z.string().min(1),
    at: z.iso.datetime(),
  })
  .strict();

/** One index line. */
export type IndexLine = z.infer<typeof IndexLine>;
