// The Claude planner: the discovery LLM on `@anthropic-ai/sdk`, one tool call per turn, with the
// marked screenshot as an image. Follows design section 9 §5.3 (model ports, call order, failures),
// section 6 §11.3 (model settings), and docs/decisions.md (M03: the stored copy is the wire copy).
import Anthropic from "@anthropic-ai/sdk";
import type { Masked } from "../../ports/masked.js";
import type {
  CallRecorder,
  ModelFailure,
  Planner,
  PlannerReply,
  PlannerTurn,
} from "../../ports/models.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";

/** How long one call may take before it counts as `timeout`. */
const CALL_TIMEOUT_MS = 120_000;
/** Room for one tool call's arguments. */
const MAX_TOKENS = 4096;

/** What the planner needs. `fetch` is swapped in tests; the real one is Node's. */
export type ClaudeOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  baseURL?: string;
};

/** The request body, built from the masked turn only (section 4 §10.1). */
export function requestBody(turn: PlannerTurn): Anthropic.MessageCreateParamsNonStreaming {
  const tools: Anthropic.Tool[] = turn.tools.map((t) => {
    // Why drop `$schema`: the API takes a plain object schema; the draft marker adds nothing.
    const schema = { ...(t.input_schema as Record<string, unknown>) };
    delete schema.$schema;
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as Anthropic.Tool.InputSchema,
    };
  });
  const content: Anthropic.ContentBlockParam[] = [];
  if (turn.image !== null) {
    const data = Buffer.from(turn.image).toString("base64");
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data } });
  }
  content.push({ type: "text", text: turn.message });
  return {
    model: turn.model,
    max_tokens: MAX_TOKENS,
    // Why a cache mark on the system block: tools and system are the same bytes every turn
    // (section 6 §11.3). The mark caches both, since tools render first.
    system: [{ type: "text", text: turn.system, cache_control: { type: "ephemeral" } }],
    tools,
    // Why: section 6 §11.3, a tool call is required, and exactly one (section 6 §10.1 step 3).
    tool_choice: { type: "any", disable_parallel_tool_use: true },
    // Why off: forced tool use, with no free text for a call to hide in. `temperature` is not
    // sent: this model rejects sampling settings (docs/decisions.md, M03).
    thinking: { type: "disabled" },
    messages: [{ role: "user", content }],
  };
}

/** Maps an SDK error to a model failure (section 9 §5.3). Only expected trouble is mapped. */
function failureOf(e: unknown): ModelFailure | null {
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

/** The Claude planner. One client per run; retries are the loop's, not the SDK's. */
export class ClaudePlanner implements Planner {
  readonly #opts: ClaudeOptions;

  constructor(opts: ClaudeOptions) {
    this.#opts = opts;
  }

  async next(
    turn: Masked<PlannerTurn>,
    record: CallRecorder,
    signal?: AbortSignal,
  ): Promise<Outcome<PlannerReply, ModelFailure | "write_failed">> {
    const inner = this.#opts.fetch ?? fetch;
    // Why an object: the flag is set inside the fetch closure.
    const state = { recordFailed: false };
    // Why a wrapped fetch: the stored copy must be the sent copy, byte for byte (section 9
    // §5.3). The bytes are written first; a failed write sends nothing.
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
      apiKey: this.#opts.apiKey,
      fetch: wired,
      maxRetries: 0,
      timeout: CALL_TIMEOUT_MS,
      ...(this.#opts.baseURL === undefined ? {} : { baseURL: this.#opts.baseURL }),
    });
    let msg: Anthropic.Message;
    try {
      msg = await client.messages.create(requestBody(turn), signal === undefined ? {} : { signal });
    } catch (e) {
      if (state.recordFailed) return fail("write_failed");
      const f = failureOf(e);
      if (f === null) throw e;
      return fail(f);
    }
    if (msg.stop_reason === "refusal") return fail("refused");
    const use = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    return ok({
      call: use === undefined ? null : { name: use.name, input: use.input },
      model: msg.model,
      usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
    });
  }
}
