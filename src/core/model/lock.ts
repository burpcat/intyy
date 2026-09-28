// The lock file format (`intyy.lock/1.0`).
// Follows design section 9 §12.1.
import { z } from "zod";

/** One lock file: owner, process ID, host, command, staff ID, start time (section 9 §12.1). */
export const LockFile = z
  .object({
    schema: z.literal("intyy.lock/1.0"),
    owner: z.string().min(1),
    pid: z.number().int().positive(),
    host: z.string().min(1),
    command: z.string().min(1),
    staff: z.string().min(1).nullable(),
    started_at: z.iso.datetime(),
  })
  .strict();

/** A lock file. The port's `LockInfo` is the same shape; `tests/types/schemas.test-d.ts` checks it. */
export type LockFile = z.infer<typeof LockFile>;
