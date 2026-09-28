// The harness port: test-mode controls of the bank app. Only certify, the kvfcu harness adapter,
// and fakes may import this file. Follows design section 9 §5.5 and section 8 §6.5.
import type { Opaque } from "./opaque.js";
import type { Outcome } from "./outcome.js";
import type { Secret } from "./secret.js";

/** Every expected harness failure (section 9 §5.5). */
export type HarnessFailure = "unsupported" | "unreachable" | "rejected";

/** One test-mode feature the app offers. Section 8 §6.5. M06. */
export type HarnessFeature = Opaque<"HarnessFeature">;
/** One named fault to inject. Section 8 §6.3. M06. */
export type NamedFault = Opaque<"NamedFault">;
/** One line of the app's fault log. Section 8 §6.5. M06. */
export type FaultLogEntry = Opaque<"FaultLogEntry">;
/** The oracle's answer. Match results only, never values. Section 8. M06. */
export type OracleAnswer = Opaque<"OracleAnswer">;

/** The harness. The adapter refuses unless the app's settings say `environment: test`. */
export interface Harness {
  /** Probes the fault log endpoint. A 404 means test mode is off: no features. */
  features(signal?: AbortSignal): Promise<Outcome<Set<HarnessFeature>, "unreachable">>;
  /** Resets the app's data. */
  reset(signal?: AbortSignal): Promise<Outcome<void, HarnessFailure>>;
  /** Sets random delays and their seed. */
  setChaos(
    c: { entropy?: number; seed?: string },
    signal?: AbortSignal,
  ): Promise<Outcome<void, HarnessFailure>>;
  /** Adds faults. */
  addFaults(f: NamedFault[], signal?: AbortSignal): Promise<Outcome<void, HarnessFailure>>;
  /** Clears every fault. */
  clearFaults(signal?: AbortSignal): Promise<Outcome<void, HarnessFailure>>;
  /** Reads the fault log. */
  faultLog(signal?: AbortSignal): Promise<Outcome<FaultLogEntry[], HarnessFailure>>;
  /** Raw notes text in memory only. The scorer stores match results, never values. */
  oracle(notes: Secret, signal?: AbortSignal): Promise<Outcome<OracleAnswer, HarnessFailure>>;
  /** Fixes the app's date, or clears it with `null`. */
  setClock(date: string | null, signal?: AbortSignal): Promise<Outcome<void, HarnessFailure>>;
}
