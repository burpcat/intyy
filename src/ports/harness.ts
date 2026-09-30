// The harness port: test-mode controls of the bank app. Only certify, the kvfcu harness adapter,
// and fakes may import this file. Follows design section 9 §5.5 and section 8 §6.5.
import type { Outcome } from "./outcome.js";
import type { Secret } from "./secret.js";

/** Every expected harness failure (section 9 §5.5). */
export type HarnessFailure = "unsupported" | "unreachable" | "rejected";

/** One test-mode feature the app offers. Section 8 §6.5. */
export type HarnessFeature = "reset" | "chaos" | "named_faults" | "fault_log" | "oracle" | "clock";

/** A named fault's effect. CONTRACT §6.2. */
export type NamedFaultKind =
  | "session_expire"
  | "known_popup"
  | "unknown_popup"
  | "supervisor_required"
  | "server_error"
  | "maintenance"
  | "drop_after_confirm";

/**
 * One named fault to inject (CONTRACT §6.2). `route` is a route key like `"GET /example/path"`.
 * `repeat` defaults to `"once"` when left out.
 */
export type NamedFault = {
  id: string;
  kind: NamedFaultKind;
  route: string;
  nth?: number;
  repeat?: "once" | "always";
};

/** One line of the app's fault log, in arrival order (CONTRACT §6.3). */
export type FaultLogEntry = {
  seq: number;
  time: string;
  method: string;
  path: string;
  route_count: number;
  decision: "pass" | "entropy" | "named";
  fault_kind: string | null;
  block_point: "before" | "after" | "none";
  style: string | null;
  named_id: string | null;
  delay_ms: number;
};

/** One account the oracle reports for a notes text (CONTRACT §8, `GET /__test__/oracle`). */
export type OracleAccount = {
  account_number: string;
  status: "OPEN" | "CLOSED";
  confirmation_number: string;
};

/** The oracle's answer: the ground truth after a lost reply (CONTRACT §8). */
export type OracleAnswer = { exists: boolean; count: number; accounts: OracleAccount[] };

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
