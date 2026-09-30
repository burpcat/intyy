// The in-memory harness fake: certify's test double for the bank app's `/__test__/` endpoints,
// with no live app. Follows design section 9 §5.5 and section 8 §6.5.
import type {
  FaultLogEntry,
  Harness,
  HarnessFailure,
  HarnessFeature,
  NamedFault,
  OracleAnswer,
} from "../ports/harness.js";
import { fail, ok, type Outcome } from "../ports/outcome.js";
import { Secret } from "../ports/secret.js";

const ALL_FEATURES: readonly HarnessFeature[] = [
  "reset",
  "chaos",
  "named_faults",
  "fault_log",
  "oracle",
  "clock",
];

/** What a test seeds before certify code runs against the fake. */
export type FakeHarnessConfig = {
  /** Default `"test"`. Set `"production"` to prove every call refuses (section 9 §5.5). */
  environment?: "test" | "production";
  /** Default every feature. A narrower set proves certify's report of a gap (section 8 §6.5). */
  features?: readonly HarnessFeature[];
};

/**
 * A harness with no live app behind it. Faults, chaos, and the clock are recorded, not enforced;
 * a test that needs `faultLog()` to answer with lines seeds them with {@link seedFaultLog}, and
 * one that needs `oracle()` to answer seeds it with {@link seedOracle}.
 */
export class FakeHarness implements Harness {
  readonly #allowed: boolean;
  readonly #features: Set<HarnessFeature>;
  #namedFaults: NamedFault[] = [];
  #log: FaultLogEntry[] = [];
  #chaos: { entropy: number; seed: string } = { entropy: 0, seed: "0" };
  #clockDate: string | null = null;
  readonly #oracle = new Map<string, OracleAnswer>();

  constructor(config: FakeHarnessConfig = {}) {
    this.#allowed = (config.environment ?? "test") === "test";
    this.#features = new Set(config.features ?? ALL_FEATURES);
  }

  /** Test setup only, never on the Harness port: the oracle's answer for one notes text. */
  seedOracle(notes: string, answer: OracleAnswer): void {
    this.#oracle.set(notes, answer);
  }

  /** Test setup only, never on the Harness port: the fault log a scenario starts with. */
  seedFaultLog(entries: readonly FaultLogEntry[]): void {
    this.#log = entries.slice();
  }

  /** The named faults added since the last reset, for a test to inspect. */
  get namedFaults(): readonly NamedFault[] {
    return this.#namedFaults;
  }

  /** The chaos setting, for a test to inspect. */
  get chaos(): { entropy: number; seed: string } {
    return { ...this.#chaos };
  }

  /** The fixed business date, or `null`, for a test to inspect. */
  get clockDate(): string | null {
    return this.#clockDate;
  }

  features(): Promise<Outcome<Set<HarnessFeature>, "unreachable">> {
    return Promise.resolve(ok(this.#allowed ? new Set(this.#features) : new Set()));
  }

  reset(): Promise<Outcome<void, HarnessFailure>> {
    const refused = this.#refuse();
    if (refused) return Promise.resolve(refused);
    this.#namedFaults = [];
    this.#log = [];
    return Promise.resolve(ok(undefined));
  }

  setChaos(c: { entropy?: number; seed?: string }): Promise<Outcome<void, HarnessFailure>> {
    const refused = this.#refuse();
    if (refused) return Promise.resolve(refused);
    if (c.entropy !== undefined) this.#chaos.entropy = c.entropy;
    if (c.seed !== undefined) this.#chaos.seed = c.seed;
    return Promise.resolve(ok(undefined));
  }

  addFaults(f: NamedFault[]): Promise<Outcome<void, HarnessFailure>> {
    const refused = this.#refuse();
    if (refused) return Promise.resolve(refused);
    const ids = new Set(this.#namedFaults.map((x) => x.id));
    for (const fault of f) {
      // Why: CONTRACT §8, `POST /__test__/faults` rejects the whole batch on a reused ID.
      if (ids.has(fault.id)) return Promise.resolve(fail("rejected", `duplicate fault id ${fault.id}`));
      ids.add(fault.id);
    }
    this.#namedFaults = [...this.#namedFaults, ...f];
    return Promise.resolve(ok(undefined));
  }

  clearFaults(): Promise<Outcome<void, HarnessFailure>> {
    const refused = this.#refuse();
    if (refused) return Promise.resolve(refused);
    this.#namedFaults = [];
    return Promise.resolve(ok(undefined));
  }

  faultLog(): Promise<Outcome<FaultLogEntry[], HarnessFailure>> {
    const refused = this.#refuse();
    if (refused) return Promise.resolve(refused);
    return Promise.resolve(ok(this.#log.slice()));
  }

  oracle(notes: Secret): Promise<Outcome<OracleAnswer, HarnessFailure>> {
    const refused = this.#refuse();
    if (refused) return Promise.resolve(refused);
    const answer = this.#oracle.get(Secret.open(notes));
    return Promise.resolve(ok(answer ?? { exists: false, count: 0, accounts: [] }));
  }

  setClock(date: string | null): Promise<Outcome<void, HarnessFailure>> {
    const refused = this.#refuse();
    if (refused) return Promise.resolve(refused);
    this.#clockDate = date;
    return Promise.resolve(ok(undefined));
  }

  /** Section 9 §5.5: the harness refuses outside test mode. `null` when the call may go on. */
  #refuse(): Outcome<never, HarnessFailure> | null {
    return this.#allowed ? null : fail("rejected", "the harness refuses off test mode");
  }
}
