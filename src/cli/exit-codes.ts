// Exit codes: one number per kind of answer, so a script can branch on the number alone.
// Follows design section 9 §7.5.

/** Every exit code (section 9 §7.5). Codes never overlap. */
export const EXIT = {
  /** Done. For runs: `success`. For certify: gate passed or batch complete. */
  ok: 0,
  /** Usage error, or intyy failed to produce an answer. */
  usage: 1,
  /** Run ended in `business_outcome`. */
  businessOutcome: 2,
  /** Run not final: `running` or `escalated` (`run status` only). */
  notFinal: 3,
  /** Run `rejected`. */
  rejected: 4,
  /** Run `failed`, or a certify gate failed. */
  failed: 5,
  /** Refused by a rule: role, four eyes, second look, freshness, a changed record. */
  refused: 6,
  /** A file failed its schema or loader checks. */
  invalid: 7,
  /** Busy: a lock is held. */
  busy: 8,
} as const;

/** One exit code. */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A run's status (section 3 §5.2). */
export type RunStatus =
  "success" | "business_outcome" | "running" | "escalated" | "rejected" | "failed";

/** The exit code for a run's status. Why `business_outcome` is not 0: "no such member" is not success. */
export function exitForStatus(status: RunStatus): ExitCode {
  switch (status) {
    case "success":
      return EXIT.ok;
    case "business_outcome":
      return EXIT.businessOutcome;
    case "running":
    case "escalated":
      return EXIT.notFinal;
    case "rejected":
      return EXIT.rejected;
    case "failed":
      return EXIT.failed;
  }
}

/**
 * The exit code for a port failure name. `rule` and `conflict` are refusals; a file that fails
 * its schema, its hash, or a merge is invalid; a held lock is busy. Anything else is usage (1).
 */
export function exitForFailure(failure: string): ExitCode {
  switch (failure) {
    case "rule":
    case "conflict":
      return EXIT.refused;
    case "invalid":
    case "hash_mismatch":
    case "loosening":
      return EXIT.invalid;
    case "busy":
      return EXIT.busy;
    default:
      return EXIT.usage;
  }
}

/** An expected CLI answer that ends the command with a code. Bugs stay plain errors. */
export class CliExit extends Error {
  /** The exit code. */
  readonly code: ExitCode;

  /** Ends the command with `code`. `message` goes to standard error, masked. */
  constructor(code: ExitCode, message: string) {
    super(message);
    this.code = code;
  }
}
