// One recorded call to Claude, shared by the planner and the reviewer. The request bytes go to
// `llm/` before they are sent, and the reply bytes once they arrive; a failed write sends nothing.
// Follows design section 9 §5.3 (model call order) and docs/decisions.md (M03: the stored copy is the wire copy).
import Anthropic from "@anthropic-ai/sdk";
import type { CallRecorder, ModelFailure } from "../../ports/models.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";

/** What a Claude adapter needs. `fetch` is swapped in tests; the real one is Node's. */
export type ClaudeOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  baseURL?: string;
  /** Overrides the adapter's own time limit, so tests need not wait. */
  timeoutMs?: number;
};

/** Maps an SDK error to a model failure (section 9 §5.3). Only expected trouble is mapped. */
function failureOf(e: unknown): ModelFailure | null {
  // Why abort is a timeout: a caller abort is how a deadline reaches the adapter (section 5 §10.7, §11.5).
  if (e instanceof Anthropic.APIUserAbortError) return "timeout";
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (e instanceof Anthropic.APIConnectionError) return "unavailable";
  if (e instanceof Anthropic.RateLimitError) return "unavailable";
  if (e instanceof Anthropic.InternalServerError) return "unavailable";
  if (e instanceof Anthropic.APIError) return "unavailable";
  return null;
}

/** The body bytes a fetch call sends. The SDK sends JSON as a string. */
function bodyBytes(body: unknown): Uint8Array<ArrayBuffer> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return new Uint8Array(body);
  throw new Error("the SDK sent a body intyy cannot store");
}

/** Sends one request and returns the API message. No SDK retries: retries belong to the caller. */
export async function sendRecorded(
  opts: ClaudeOptions,
  body: Anthropic.MessageCreateParamsNonStreaming,
  record: CallRecorder,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Outcome<Anthropic.Message, ModelFailure | "write_failed">> {
  const inner = opts.fetch ?? fetch;
  // Why an object: the flag is set inside the fetch closure.
  const state = { recordFailed: false };
  // Why a wrapped fetch: the stored copy must be the sent copy, byte for byte (section 9 §5.3).
  // The bytes are written first; a failed write sends nothing.
  const wired: typeof fetch = async (url, init) => {
    const bytes = bodyBytes(init?.body);
    if (!(await record("request", bytes))) {
      state.recordFailed = true;
      throw new Error("the llm/ write failed; nothing was sent");
    }
    const res = await inner(url, { ...init, body: bytes });
    const reply = new Uint8Array(await res.arrayBuffer());
    if (!(await record("reply", reply))) {
      state.recordFailed = true;
      throw new Error("the llm/ reply write failed");
    }
    return new Response(reply, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
  const client = new Anthropic({
    apiKey: opts.apiKey,
    fetch: wired,
    maxRetries: 0,
    timeout: timeoutMs,
    ...(opts.baseURL === undefined ? {} : { baseURL: opts.baseURL }),
  });
  try {
    return ok(await client.messages.create(body, signal === undefined ? {} : { signal }));
  } catch (e) {
    if (state.recordFailed) return fail("write_failed");
    const f = failureOf(e);
    if (f === null) throw e;
    return fail(f);
  }
}
