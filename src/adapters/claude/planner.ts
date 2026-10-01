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
import { sendRecorded, type ClaudeOptions } from "./send.js";

/** How long one call may take before it counts as `timeout`. */
const CALL_TIMEOUT_MS = 120_000;
/** Room for one tool call's arguments. */
const MAX_TOKENS = 4096;

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

/** The planner reply in an API message: its one tool call, or `refused` (section 9 §5.3). */
export function replyOf(msg: Anthropic.Message): PlannerReply | "refused" {
  if (msg.stop_reason === "refusal") return "refused";
  const use = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  return {
    call: use === undefined ? null : { name: use.name, input: use.input },
    model: msg.model,
    usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
  };
}

/** The Claude planner. One client per call; retries are the loop's, not the SDK's. */
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
    const sent = await sendRecorded(
      this.#opts,
      requestBody(turn),
      record,
      this.#opts.timeoutMs ?? CALL_TIMEOUT_MS,
      signal,
    );
    if (!sent.ok) return sent;
    const reply = replyOf(sent.value);
    return reply === "refused" ? fail("refused") : ok(reply);
  }
}
