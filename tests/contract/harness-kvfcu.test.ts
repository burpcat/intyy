// Runs the harness contract against KvfcuHarness, pointed at a mock of CONTRACT §8's
// `/__test__/` endpoints on 127.0.0.1. Also proves the adapter's own rules: never follow a
// redirect, and refuse every op with no network call unless test mode and loopback both hold.
// Design section 9 §5.5 and section 8 §6.5, §8.
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { KvfcuHarness } from "../../src/adapters/kvfcu-harness/harness.js";
import type { FaultLogEntry, OracleAnswer } from "../../src/ports/harness.js";
import { Secret } from "../../src/ports/secret.js";
import { harnessContract } from "./harness.suite.js";

/** True when `v` is a plain, non-null object. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** One named fault as the wire sends it, loosely typed for the mock. */
type RawFault = { id: string; kind: string; route: string; nth?: number; repeat?: string };

function isFaultLike(v: unknown): v is RawFault {
  return isRecord(v) && typeof v.id === "string" && typeof v.kind === "string" && typeof v.route === "string";
}

/** CONTRACT §8: the body may be one fault, a list, or `{faults: [...]}`. `null` when malformed. */
function toFaultList(body: unknown): RawFault[] | null {
  if (Array.isArray(body)) return body.every(isFaultLike) ? body : null;
  if (isRecord(body) && Array.isArray(body.faults)) {
    return body.faults.every(isFaultLike) ? body.faults : null;
  }
  if (isFaultLike(body)) return [body];
  return null;
}

/** A minimal mock of CONTRACT §8's test endpoints, on one 127.0.0.1 port per test. */
class MockKvfcuServer {
  readonly #server: Server;
  #port = 0;
  readonly requests: { method: string; path: string }[] = [];
  #testMode = true;
  readonly #faultIds = new Set<string>();
  #faultLog: FaultLogEntry[] = [];
  readonly #oracle = new Map<string, OracleAnswer>();
  #redirectPath: string | null = null;

  constructor() {
    this.#server = createServer((req, res) => {
      this.#handle(req, res).catch((err: unknown) => {
        res.writeHead(500);
        res.end(String(err));
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    this.#port = (this.#server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  get origin(): string {
    return `http://127.0.0.1:${String(this.#port)}`;
  }

  /** Test mode off: every `/__test__/` path answers 404 (CONTRACT §8). */
  setTestMode(on: boolean): void {
    this.#testMode = on;
  }

  seedFaultLog(entries: readonly FaultLogEntry[]): void {
    this.#faultLog = entries.slice();
  }

  seedOracle(notes: string, answer: OracleAnswer): void {
    this.#oracle.set(notes, answer);
  }

  /** The next request to this path answers with a 302, whatever the method. */
  redirectOn(path: string): void {
    this.#redirectPath = path;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://mock");
    this.requests.push({ method: req.method ?? "GET", path: url.pathname });
    const chunks: Buffer[] = [];
    for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        this.#send(res, 400, { error: "malformed JSON" });
        return;
      }
    }

    if (this.#redirectPath !== null && url.pathname === this.#redirectPath) {
      res.writeHead(302, { location: "http://127.0.0.1:1/should-not-be-followed" });
      res.end();
      return;
    }
    if (!this.#testMode) {
      this.#send(res, 404, { error: "test mode is off" });
      return;
    }

    if (url.pathname === "/__test__/reset" && req.method === "POST") {
      this.#faultIds.clear();
      this.#faultLog = [];
      this.#send(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/__test__/chaos" && req.method === "POST") {
      this.#send(res, 200, { entropy: 0, seed: "0", ...(isRecord(body) ? body : {}) });
      return;
    }
    if (url.pathname === "/__test__/faults" && req.method === "POST") {
      const list = toFaultList(body);
      if (list === null) {
        this.#send(res, 400, { error: "malformed faults body" });
        return;
      }
      const ids = list.map((f) => f.id);
      const dup = ids.some((id, i) => ids.indexOf(id) !== i || this.#faultIds.has(id));
      if (dup) {
        this.#send(res, 400, { error: "duplicate fault id" });
        return;
      }
      for (const id of ids) this.#faultIds.add(id);
      this.#send(res, 200, {
        faults: list.map((f) => ({ ...f, repeat: f.repeat ?? "once", fired: false })),
      });
      return;
    }
    if (url.pathname === "/__test__/faults" && req.method === "DELETE") {
      this.#faultIds.clear();
      this.#send(res, 200, { faults: [] });
      return;
    }
    if (url.pathname === "/__test__/faultlog" && req.method === "GET") {
      this.#send(res, 200, { entries: this.#faultLog });
      return;
    }
    if (url.pathname === "/__test__/oracle" && req.method === "GET") {
      const notes = url.searchParams.get("notes") ?? "";
      const answer = this.#oracle.get(notes) ?? { exists: false, count: 0, accounts: [] };
      this.#send(res, 200, answer);
      return;
    }
    if (url.pathname === "/__test__/clock" && req.method === "POST") {
      const date = isRecord(body) && typeof body.date === "string" ? body.date : null;
      this.#send(res, 200, { date: date ?? "2026-01-15", fixed: date !== null });
      return;
    }
    this.#send(res, 404, { error: "no such test endpoint" });
  }

  #send(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  }
}

let server: MockKvfcuServer;

beforeEach(async () => {
  server = new MockKvfcuServer();
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

harnessContract("kvfcu", () => {
  return Promise.resolve({
    harness: new KvfcuHarness({ origin: server.origin, environment: "test" }),
    seedFaultLog: (entries) => {
      server.seedFaultLog(entries);
    },
    seedOracle: (notes, answer) => {
      server.seedOracle(notes, answer);
    },
  });
});

// Why: case 2, build brief M06 task 6. A redirect is never followed, and the mock never sees
// a request to the Location it named.
describe("KvfcuHarness: a redirect is never followed", () => {
  test("a 302 reply ends unreachable, with no follow-up request", async () => {
    server.redirectOn("/__test__/reset");
    const harness = new KvfcuHarness({ origin: server.origin, environment: "test" });
    expect(await harness.reset()).toMatchObject({ ok: false, failure: "unreachable" });
    expect(server.requests).toEqual([{ method: "POST", path: "/__test__/reset" }]);
  });
});

// Why: case 3, build brief M06 task 6. Off test mode, or off loopback, every op fails
// rejected with zero network calls, and features() answers an empty set.
describe("KvfcuHarness: refuses with no network call", () => {
  test("environment not \"test\" refuses every op, and the mock sees no request", async () => {
    const harness = new KvfcuHarness({ origin: server.origin, environment: "production" });
    expect(await harness.features()).toEqual({ ok: true, value: new Set() });
    expect(await harness.reset()).toMatchObject({ ok: false, failure: "rejected" });
    expect(await harness.setChaos({ entropy: 0.1 })).toMatchObject({ ok: false, failure: "rejected" });
    expect(
      await harness.addFaults([{ id: "x", kind: "server_error", route: "GET /example" }]),
    ).toMatchObject({ ok: false, failure: "rejected" });
    expect(await harness.clearFaults()).toMatchObject({ ok: false, failure: "rejected" });
    expect(await harness.faultLog()).toMatchObject({ ok: false, failure: "rejected" });
    expect(await harness.oracle(new Secret("some notes"))).toMatchObject({
      ok: false,
      failure: "rejected",
    });
    expect(await harness.setClock("2026-01-15")).toMatchObject({ ok: false, failure: "rejected" });
    expect(server.requests).toEqual([]);
  });

  test("a non-loopback origin refuses every op, and the mock sees no request", async () => {
    // Why: the origin is never dialed when refused, so any non-loopback host is safe to name.
    const harness = new KvfcuHarness({
      origin: "http://bank-app.example:8080",
      environment: "test",
    });
    expect(await harness.features()).toEqual({ ok: true, value: new Set() });
    expect(await harness.reset()).toMatchObject({ ok: false, failure: "rejected" });
    expect(await harness.oracle(new Secret("some notes"))).toMatchObject({
      ok: false,
      failure: "rejected",
    });
    expect(server.requests).toEqual([]);
  });
});
