// In-memory alert store, the fake twin of the file adapter.
// Follows design section 9 §5.9 (stores in memory). Same ID rules and read checks as the file adapter.
import type { z } from "zod";
import { assertSafeName } from "../core/model/safe-path.js";
import type { AlertStore } from "../ports/alerts.js";
import { fail, ok, type Outcome } from "../ports/outcome.js";

/** Alerts in a map. Set `failWrites` to make every `put` return `write_failed`, like a full disk. */
export class FakeAlertStore<A> implements AlertStore<A> {
  /** When true, `put` fails. */
  failWrites = false;
  readonly #schema: z.ZodType<A>;
  readonly #files = new Map<string, unknown>();

  /** A store whose alerts follow `schema`. */
  constructor(schema: z.ZodType<A>) {
    this.#schema = schema;
  }

  /** Writes one alert (a JSON round trip, like a file). */
  put(id: string, alert: A): Promise<Outcome<void, "write_failed">> {
    assertSafeName(id);
    if (this.failWrites) return Promise.resolve(fail("write_failed", "fake write failure"));
    this.#files.set(id, JSON.parse(JSON.stringify(alert)) as unknown);
    return Promise.resolve(ok(undefined));
  }

  /** Reads one alert. */
  get(id: string): Promise<Outcome<A, "not_found" | "invalid">> {
    assertSafeName(id);
    if (!this.#files.has(id)) return Promise.resolve(fail("not_found", id));
    const parsed = this.#schema.safeParse(this.#files.get(id));
    return Promise.resolve(parsed.success ? ok(parsed.data) : fail("invalid", parsed.error.message));
  }

  /** Reads every alert, sorted by ID. */
  async list(): Promise<Outcome<A[], "invalid">> {
    const out: A[] = [];
    for (const id of [...this.#files.keys()].sort()) {
      const one = await this.get(id);
      if (!one.ok) return fail("invalid", one.detail ?? one.failure);
      out.push(one.value);
    }
    return ok(out);
  }
}
