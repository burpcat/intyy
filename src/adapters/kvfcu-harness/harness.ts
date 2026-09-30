// The kvfcu harness adapter: plain HTTP from Node to the app's `/__test__/` endpoints
// (CONTRACT §8), never through the browser. Follows design section 8 §6.5 and section 9 §5.5.
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type {
  FaultLogEntry,
  Harness,
  HarnessFailure,
  HarnessFeature,
  NamedFault,
  OracleAccount,
  OracleAnswer,
} from "../../ports/harness.js";
import { Secret } from "../../ports/secret.js";

const ALL_FEATURES: readonly HarnessFeature[] = [
  "reset",
  "chaos",
  "named_faults",
  "fault_log",
  "oracle",
  "clock",
];

/** Loopback hosts the harness will ever contact, whatever the settings origin says. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** What the adapter needs from the app's settings (section 4 §5.2, section 9 §5.5). */
export type KvfcuHarnessConfig = { origin: string; environment: "test" | "production" };

/** One raw HTTP reply, before it is mapped to a `HarnessFailure`. */
type RawReply = { status: number; body: unknown };

/** Reads `body.error` as a string, else `undefined`. CONTRACT §8: a 400 body is `{"error": "…"}`. */
function errorDetail(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || !("error" in body)) return undefined;
  const e = (body as { error?: unknown }).error;
  return typeof e === "string" ? e : undefined;
}

/**
 * Talks to one kvfcu instance's `/__test__/` endpoints. Refuses every call, with no network
 * request, unless the origin is loopback and the settings say `environment: test` (section 9 §5.5).
 */
export class KvfcuHarness implements Harness {
  readonly #origin: string;
  readonly #allowed: boolean;

  constructor(config: KvfcuHarnessConfig) {
    this.#origin = config.origin;
    this.#allowed =
      config.environment === "test" && LOOPBACK_HOSTS.has(new URL(config.origin).hostname);
  }

  async features(signal?: AbortSignal): Promise<Outcome<Set<HarnessFeature>, "unreachable">> {
    if (!this.#allowed) return ok(new Set());
    const sent = await this.#send("GET", "/__test__/faultlog", undefined, signal);
    if (!sent.ok) return sent;
    if (sent.value.status === 404) return ok(new Set());
    if (sent.value.status === 200) return ok(new Set(ALL_FEATURES));
    return fail("unreachable", `unexpected status ${String(sent.value.status)}`);
  }

  async reset(signal?: AbortSignal): Promise<Outcome<void, HarnessFailure>> {
    return this.#call("POST", "/__test__/reset", undefined, () => undefined, signal);
  }

  async setChaos(
    c: { entropy?: number; seed?: string },
    signal?: AbortSignal,
  ): Promise<Outcome<void, HarnessFailure>> {
    return this.#call("POST", "/__test__/chaos", c, () => undefined, signal);
  }

  async addFaults(f: NamedFault[], signal?: AbortSignal): Promise<Outcome<void, HarnessFailure>> {
    return this.#call("POST", "/__test__/faults", { faults: f }, () => undefined, signal);
  }

  async clearFaults(signal?: AbortSignal): Promise<Outcome<void, HarnessFailure>> {
    return this.#call("DELETE", "/__test__/faults", undefined, () => undefined, signal);
  }

  async faultLog(signal?: AbortSignal): Promise<Outcome<FaultLogEntry[], HarnessFailure>> {
    return this.#call("GET", "/__test__/faultlog", undefined, parseFaultLog, signal);
  }

  async oracle(notes: Secret, signal?: AbortSignal): Promise<Outcome<OracleAnswer, HarnessFailure>> {
    if (!this.#allowed) return fail("rejected", "the harness refuses off test mode or off loopback");
    const url = new URL("/__test__/oracle", this.#origin);
    url.searchParams.set("notes", Secret.open(notes));
    const sent = await this.#raw("GET", url, undefined, signal);
    if (!sent.ok) return sent;
    return this.#map(sent.value, parseOracleAnswer);
  }

  async setClock(date: string | null, signal?: AbortSignal): Promise<Outcome<void, HarnessFailure>> {
    return this.#call("POST", "/__test__/clock", { date }, () => undefined, signal);
  }

  /** Runs one call: the test-mode guard, the request, then the reply mapping. */
  async #call<T>(
    method: string,
    path: string,
    body: unknown,
    parse: (body: unknown) => T | null,
    signal?: AbortSignal,
  ): Promise<Outcome<T, HarnessFailure>> {
    if (!this.#allowed) return fail("rejected", "the harness refuses off test mode or off loopback");
    const sent = await this.#send(method, path, body, signal);
    if (!sent.ok) return sent;
    return this.#map(sent.value, parse);
  }

  /** Maps one HTTP reply to an `Outcome`, by CONTRACT §8's status codes. */
  #map<T>(raw: RawReply, parse: (body: unknown) => T | null): Outcome<T, HarnessFailure> {
    if (raw.status === 404) return fail("unsupported", "test mode is off");
    if (raw.status === 400) return fail("rejected", errorDetail(raw.body));
    if (raw.status !== 200) return fail("unreachable", `unexpected status ${String(raw.status)}`);
    const value = parse(raw.body);
    return value === null ? fail("unreachable", "the harness reply had an unexpected shape") : ok(value);
  }

  /** Sends one request under `this.#origin`. Never follows a redirect. */
  #send(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Outcome<RawReply, "unreachable">> {
    return this.#raw(method, new URL(path, this.#origin), body, signal);
  }

  async #raw(
    method: string,
    url: URL,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Outcome<RawReply, "unreachable">> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        redirect: "manual",
        signal: signal ?? null,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
    } catch (err) {
      return fail("unreachable", err instanceof Error ? err.message : "network error");
    }
    // Why: `redirect: "manual"` never follows a hop (CLAUDE.md; docs/decisions.md, M02). Node's
    // fetch reports a manual redirect as a normal 3xx reply, not the browser's `opaqueredirect`.
    if (res.status >= 300 && res.status < 400) {
      return fail("unreachable", "the harness endpoint redirected");
    }
    let parsedBody: unknown;
    try {
      parsedBody = res.status === 204 ? undefined : await res.json();
    } catch {
      return fail("unreachable", "the harness reply was not JSON");
    }
    return ok({ status: res.status, body: parsedBody });
  }
}

/** True when `v` is a plain, non-null object. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Parses `GET /__test__/faultlog`'s body (CONTRACT §6.3). */
function parseFaultLog(body: unknown): FaultLogEntry[] | null {
  if (!isRecord(body) || !Array.isArray(body.entries)) return null;
  const out: FaultLogEntry[] = [];
  for (const e of body.entries) {
    if (!isRecord(e)) return null;
    if (
      typeof e.seq !== "number" ||
      typeof e.time !== "string" ||
      typeof e.method !== "string" ||
      typeof e.path !== "string" ||
      typeof e.route_count !== "number" ||
      (e.decision !== "pass" && e.decision !== "entropy" && e.decision !== "named") ||
      (typeof e.fault_kind !== "string" && e.fault_kind !== null) ||
      (e.block_point !== "before" && e.block_point !== "after" && e.block_point !== "none") ||
      (typeof e.style !== "string" && e.style !== null) ||
      (typeof e.named_id !== "string" && e.named_id !== null) ||
      typeof e.delay_ms !== "number"
    ) {
      return null;
    }
    out.push({
      seq: e.seq,
      time: e.time,
      method: e.method,
      path: e.path,
      route_count: e.route_count,
      decision: e.decision,
      fault_kind: e.fault_kind,
      block_point: e.block_point,
      style: e.style,
      named_id: e.named_id,
      delay_ms: e.delay_ms,
    });
  }
  return out;
}

/** Parses `GET /__test__/oracle`'s body (CONTRACT §8). */
function parseOracleAnswer(body: unknown): OracleAnswer | null {
  if (!isRecord(body) || typeof body.exists !== "boolean" || typeof body.count !== "number") {
    return null;
  }
  if (!Array.isArray(body.accounts)) return null;
  const accounts: OracleAccount[] = [];
  for (const a of body.accounts) {
    if (
      !isRecord(a) ||
      typeof a.account_number !== "string" ||
      (a.status !== "OPEN" && a.status !== "CLOSED") ||
      typeof a.confirmation_number !== "string"
    ) {
      return null;
    }
    accounts.push({ account_number: a.account_number, status: a.status, confirmation_number: a.confirmation_number });
  }
  return { exists: body.exists, count: body.count, accounts };
}
