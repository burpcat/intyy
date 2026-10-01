// The jev classifier: ladder rung 2 and reconciliation on TypeSafe AI's Jev ("System One"), through
// the vendor SDK `@typesafe-ai/sdk`. Each call asks ONE `choice` question and maps the chosen label
// to the core's output format. The core re-checks the output (`jev-verdict.ts`), so this file
// only builds the provider's request and reads its reply.
// Follows design section 5 §10 (jev, §10.7 when jev fails), section 7 §8 (the 2 s limit) and
// section 9 §5.3 (call order, failures). SDK facts are quoted from the doc comments of
// `@typesafe-ai/sdk` 0.6.0 (`dist/index.d.mts`): this build could not open docs.typesafe.ai.
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  choice,
  TypeSafeClient,
  type Fetch,
  type JsonValue,
} from "@typesafe-ai/sdk";
import { z } from "zod";
import { Confidence } from "../../core/model/jev.js";
import type { Masked } from "../../ports/masked.js";
import type {
  CallFailure,
  CallRecorder,
  Classifier,
  JevReconcileInput,
  JevReconcileOutput,
  JevTroubleInput,
  JevTroubleOutput,
  ModelFailure,
} from "../../ports/models.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";

/**
 * The pinned model, never an alias like `jev-latest` (docs/decisions.md, M09, 2026-10-01).
 * Why: section 5 §10.8, "a new jev version can change verdicts", so the version is frozen.
 */
export const JEV_MODEL = "jev-1.13.0";

/** The time limit: 2 s (section 7 §8, section 5 §10.7). Past it, `timeout`. */
const CALL_TIMEOUT_MS = 2_000;

/** The one question's name in the request and the reply. */
const QUESTION = "pick";

/** What a jev adapter needs. `fetch` is swapped in tests; the real one is Node's. */
export type JevOptions = {
  apiKey: string;
  fetch?: Fetch;
  baseURL?: string;
  /** Overrides the adapter's own time limit, so tests need not wait. */
  timeoutMs?: number;
};

/**
 * The reply fields intyy reads. The SDK's types are not checked at run time (`parseBody` casts),
 * so a bad body is caught here. Extra fields are allowed: `usage` and `probabilities` are stored
 * in the `llm/` reply file but not read.
 */
const Reply = z.object({
  model: z.string(),
  answers: z.object({
    [QUESTION]: z.object({ type: z.literal("choice"), choice: z.string(), confidence: Confidence }),
  }),
});

/** Copies a typed value into the SDK's JSON-only state type (no `undefined`, no class instances). */
function asState(value: unknown): { [key: string]: JsonValue } {
  return JSON.parse(JSON.stringify(value)) as { [key: string]: JsonValue };
}

/** The body bytes a fetch call sends. The SDK sends JSON as a string. */
function bodyBytes(body: unknown): Uint8Array<ArrayBuffer> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return new Uint8Array(body);
  throw new Error("the SDK sent a body intyy cannot store");
}

/**
 * Maps an SDK error to a model failure (section 9 §5.3). Only expected trouble is mapped.
 * Why every API error is `unavailable`: section 5 §10.7 has one rule for "no answer": 401, 429
 * (`RateLimitError`) and 5xx all mean jev gave none, so the ladder climbs. We never retry.
 */
function failureOf(e: unknown): ModelFailure | null {
  // Why abort is a timeout: a caller abort is how a deadline reaches the adapter (section 5 §10.7).
  if (e instanceof APIUserAbortError) return "timeout";
  // The SDK: "The full response did not arrive within the timeout. A kind of `APIConnectionError`."
  if (e instanceof APITimeoutError) return "timeout";
  if (e instanceof APIConnectionError) return "unavailable";
  if (e instanceof APIError) return "unavailable";
  return null;
}

/**
 * Sends one `choice` question and returns the chosen label with jev's confidence. The request
 * bytes go to `llm/` before they are sent, and the reply bytes once they arrive; a failed write
 * sends nothing (section 9 §5.3). A label we did not offer is `invalid_output` (section 5 §10.7).
 */
async function ask(
  opts: JevOptions,
  state: { [key: string]: JsonValue },
  question: ReturnType<typeof choice>,
  record: CallRecorder,
  signal?: AbortSignal,
): Promise<Outcome<{ label: string; confidence: number }, CallFailure>> {
  const inner = opts.fetch ?? ((url, init) => fetch(url, init));
  // Why an object: the flag is set inside the fetch closure.
  const flags = { recordFailed: false };
  // Why a wrapped fetch: the stored copy must be the sent copy, byte for byte (section 9 §5.3).
  const wired: Fetch = async (url, init) => {
    const bytes = bodyBytes(init?.body);
    if (!(await record("request", bytes))) {
      flags.recordFailed = true;
      throw new Error("the llm/ write failed; nothing was sent");
    }
    const res = await inner(url, { ...init, body: bytes });
    const reply = new Uint8Array(await res.arrayBuffer());
    if (!(await record("reply", reply))) {
      flags.recordFailed = true;
      throw new Error("the llm/ reply write failed");
    }
    return new Response(reply, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
  const client = new TypeSafeClient({
    apiKey: opts.apiKey,
    fetch: wired,
    // Why off: at `debug` the SDK logs request bodies. No model text goes to a log (CLAUDE.md, Data).
    logLevel: "off",
    ...(opts.baseURL === undefined ? {} : { baseURL: opts.baseURL }),
  });
  try {
    const res: unknown = await client.systemOne(
      { state, questions: { [QUESTION]: question }, model: JEV_MODEL },
      {
        // The SDK: "Timeout per attempt in milliseconds; there is no total retry budget." With
        // no retries, one attempt is the whole call, so this is the 2 s limit.
        timeout: opts.timeoutMs ?? CALL_TIMEOUT_MS,
        // Why none: the SDK retries 408, 429 and 5xx twice by default. The design has no jev retry
        // (section 5 §10.7: "jev never blocks the ladder"), and a retry would outlast 2 s.
        retry: { maxRetries: 0 },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const parsed = Reply.safeParse(res);
    if (!parsed.success) return fail("invalid_output");
    const pick = parsed.data.answers[QUESTION];
    if (!Object.hasOwn(question.criteria, pick.choice)) return fail("invalid_output");
    return ok({ label: pick.choice, confidence: pick.confidence });
  } catch (e) {
    if (flags.recordFailed) return fail("write_failed");
    const f = failureOf(e);
    if (f === null) throw e;
    return fail(f);
  }
}

/** Label prefixes for the step-trouble question. A prefix keeps a handler ID and an outcome code apart. */
const HANDLER = "handler:";
const OUTCOME = "outcome:";

/** The step-trouble question (section 5 §10.1, §10.3). jev sorts; it never invents an action. */
const TROUBLE_INSTRUCTIONS =
  "A step of a bank back-office task failed. The state holds the failed step, the condition that failed, and the masked screen. " +
  "Pick the one label that fits the screen best. " +
  "Pick a handler label when that handler describes what the screen shows. " +
  "Pick an outcome label when the screen shows that business outcome. " +
  "Pick needs_review when no label clearly fits. " +
  "Pick unsafe when acting on this screen could change data by mistake.";

/** The reconciliation question (section 5 §10.5). jev decides the answer, never the action. */
const RECONCILE_INSTRUCTIONS =
  "A commit step ran, and its result is not known. A check run then looked for the result. " +
  "The state holds the commit step, the check run, and the final screens, all masked. " +
  "Say whether the commit happened.";

/** The Jev classifier. */
export class JevClassifier implements Classifier {
  readonly #opts: JevOptions;

  constructor(opts: JevOptions) {
    this.#opts = opts;
  }

  /**
   * Sorts one piece of trouble into a bucket (section 5 §10.3). Labels: `handler:<id>` per frozen
   * handler, `outcome:<code>` per declared outcome, `needs_review`, and `unsafe`.
   */
  async trouble(
    input: Masked<JevTroubleInput>,
    record: CallRecorder,
    signal?: AbortSignal,
  ): Promise<Outcome<JevTroubleOutput, CallFailure>> {
    // Why split out: the handlers and outcomes are the answer labels, so they are not sent twice.
    const { handlers, outcomes, ...rest } = input;
    const criteria: Record<string, string> = {};
    for (const h of handlers) criteria[`${HANDLER}${h.id}`] = h.description;
    for (const o of outcomes) criteria[`${OUTCOME}${o.code}`] = o.description;
    criteria["needs_review"] = "No other label clearly fits, or the screen is unclear.";
    criteria["unsafe"] = "Acting on this screen could change data by mistake.";
    const got = await ask(
      this.#opts,
      asState(rest),
      choice(TROUBLE_INSTRUCTIONS, criteria),
      record,
      signal,
    );
    if (!got.ok) return got;
    const { label, confidence } = got.value;
    if (label.startsWith(HANDLER))
      return ok({ bucket: "handler", handler: label.slice(HANDLER.length), outcome: null, confidence });
    if (label.startsWith(OUTCOME))
      return ok({ bucket: "outcome", handler: null, outcome: label.slice(OUTCOME.length), confidence });
    // Only the two fixed labels are left: `ask` refused any label that was not offered.
    return ok({
      bucket: label === "unsafe" ? "unsafe" : "needs_review",
      handler: null,
      outcome: null,
      confidence,
    });
  }

  /** Judges one reconciliation check: `found`, `not_found`, or `unclear` (section 5 §10.5). */
  async reconcile(
    input: Masked<JevReconcileInput>,
    record: CallRecorder,
    signal?: AbortSignal,
  ): Promise<Outcome<JevReconcileOutput, CallFailure>> {
    const got = await ask(
      this.#opts,
      asState(input),
      choice(RECONCILE_INSTRUCTIONS, {
        found: "The check shows the commit happened.",
        not_found: "The check shows the commit did not happen.",
        unclear: "The check does not show either.",
      }),
      record,
      signal,
    );
    if (!got.ok) return got;
    const verdict = got.value.label === "found" || got.value.label === "not_found" ? got.value.label : "unclear";
    return ok({ verdict, confidence: got.value.confidence });
  }
}
