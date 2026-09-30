// Shared test harness for certify: a `Harness` double that derives `faultLog()` from the gate
// lines of every run an `Ids` wrapper tells it about, cumulatively since the last `reset()`.
// `FakeHarness` alone has no live app behind it, so it cannot simulate a named fault actually
// firing; this exists only so `runCertifyCase`'s own route map and faults.jsonl logic have real
// gate-line timings to work from. Not a test file itself: no `describe`/`test` here. Design
// section 8 §6.4, §6.5. M06 task 8.
import { actionTimesFromRunLog } from "../../../src/core/certify/route-map.js";
import { FakeHarness } from "../../../src/fakes/harness.js";
import type { Ids } from "../../../src/ports/clock.js";
import type {
  FaultLogEntry,
  Harness,
  HarnessFailure,
  HarnessFeature,
  NamedFault,
  OracleAnswer,
} from "../../../src/ports/harness.js";
import { ok, type Outcome } from "../../../src/ports/outcome.js";
import type { Secret } from "../../../src/ports/secret.js";
import type { EvidenceStore } from "../../../src/ports/stores.js";

/** Wraps `base`, but derives `faultLog()` from the gate lines of every run `noteRun` named so
 * far, cumulatively since the last `reset()` (matching `runCertifyCase`'s own behavior: it
 * resets once, before the baseline, and never again before the case). `routeFor` invents one
 * route per request-sending step; a step missing from it is treated as a fill, like a real app
 * would show no request for one. */
export class RouteMappingHarness implements Harness {
  readonly #base: FakeHarness;
  readonly #evidence: EvidenceStore;
  readonly #tenant: string;
  readonly #routeFor: Readonly<Record<string, string>>;
  #runIds: string[] = [];
  readonly #calls: string[] = [];

  constructor(base: FakeHarness, evidence: EvidenceStore, tenant: string, routeFor: Readonly<Record<string, string>>) {
    this.#base = base;
    this.#evidence = evidence;
    this.#tenant = tenant;
    this.#routeFor = routeFor;
  }

  /** Called every time the test's `Ids` mints a fresh run ID, so this harness knows which run's
   * gate lines belong to the current attempt. */
  noteRun(runId: string): void {
    this.#runIds.push(runId);
  }

  /** Every harness method called, in order, for a test that checks call order (section 8 §6.4:
   * a `reset` between the baseline and the case run, so counters repeat). */
  get calls(): readonly string[] {
    return this.#calls;
  }

  features(): Promise<Outcome<Set<HarnessFeature>, "unreachable">> {
    this.#calls.push("features");
    return this.#base.features();
  }

  reset(): Promise<Outcome<void, HarnessFailure>> {
    this.#calls.push("reset");
    this.#runIds = [];
    return this.#base.reset();
  }

  setChaos(c: { entropy?: number; seed?: string }): Promise<Outcome<void, HarnessFailure>> {
    this.#calls.push("setChaos");
    return this.#base.setChaos(c);
  }

  addFaults(f: NamedFault[]): Promise<Outcome<void, HarnessFailure>> {
    this.#calls.push("addFaults");
    return this.#base.addFaults(f);
  }

  clearFaults(): Promise<Outcome<void, HarnessFailure>> {
    this.#calls.push("clearFaults");
    return this.#base.clearFaults();
  }

  async faultLog(signal?: AbortSignal): Promise<Outcome<FaultLogEntry[], HarnessFailure>> {
    this.#calls.push("faultLog");
    const entries: FaultLogEntry[] = [];
    const counters = new Map<string, number>();
    let seq = 0;
    for (const runId of this.#runIds) {
      const events = await this.#evidence.events(this.#tenant, runId, signal);
      if (!events.ok) continue;
      for (const a of actionTimesFromRunLog(events.value)) {
        const route = this.#routeFor[a.step];
        if (route === undefined) continue;
        seq += 1;
        const count = (counters.get(route) ?? 0) + 1;
        counters.set(route, count);
        const [method, ...rest] = route.split(" ");
        entries.push({
          seq,
          time: a.at,
          method: method ?? "GET",
          path: rest.join(" "),
          route_count: count,
          decision: "pass",
          fault_kind: null,
          block_point: "none",
          style: null,
          named_id: null,
          delay_ms: 0,
        });
      }
    }
    return ok(entries);
  }

  oracle(notes: Secret): Promise<Outcome<OracleAnswer, HarnessFailure>> {
    return this.#base.oracle(notes);
  }

  setClock(date: string | null): Promise<Outcome<void, HarnessFailure>> {
    return this.#base.setClock(date);
  }

  /** Test setup only, never on the Harness port. */
  seedOracle(notes: string, answer: OracleAnswer): void {
    this.#base.seedOracle(notes, answer);
  }
}

/** Wraps `base`, telling `harness` about every freshly minted run ID. */
export function idsNotifying(base: Ids, harness: RouteMappingHarness): Ids {
  return {
    runId: () => {
      const id = base.runId();
      harness.noteRun(id);
      return id;
    },
    batchId: () => base.batchId(),
    leaseToken: () => base.leaseToken(),
    alertId: () => base.alertId(),
    candidateId: () => base.candidateId(),
  };
}

/** `open_sub`'s two request-sending steps (click, not type/read; docs/decisions.md, M04),
 * mapped to invented routes. Shared by every test that certifies `kvfcu/open_sub@1`. */
export const OPEN_SUB_ROUTE_FOR = { click_search: "POST /search", click_confirm: "POST /confirm" };
