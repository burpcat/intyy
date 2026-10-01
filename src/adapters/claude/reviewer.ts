// The Claude reviewer: ladder rung 3 on `@anthropic-ai/sdk`. `fixStep` makes one tool call (one
// action, or give up); `secondOpinion` makes one `answer` call. The core owns the prompts, tools,
// and output checks; this file only builds the provider's request and reads its reply.
// Follows design section 5 §11 (the reviewer), §10.6, section 9 §5.3 (call order, failures), and
// section 4 §10.8 (the reviewer sees element IDs and the masked screenshot).
import type Anthropic from "@anthropic-ai/sdk";
import { JevReconcileOutput } from "../../core/model/jev.js";
import {
  FIX_SYSTEM,
  FIX_TOOLS,
  OPINION_SYSTEM,
  OPINION_TOOLS,
  REVIEWER_MODEL,
  fixMessage,
  fixOutputOf,
  opinionMessage,
  type ReviewerTool,
} from "../../core/replay/reviewer-prompt.js";
import type { Masked } from "../../ports/masked.js";
import type {
  CallFailure,
  CallRecorder,
  JevReconcileInput,
  JevReconcileOutput as JevReconcileOutputType,
  Reviewer,
  ReviewerInput,
  ReviewerOutput,
} from "../../ports/models.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import { sendRecorded, type ClaudeOptions } from "./send.js";

/** The reviewer's time limit: 60 s (section 5 §11.5, section 7 §8). Past it, `timeout`. */
const CALL_TIMEOUT_MS = 60_000;
/** Room for one tool call's arguments. */
const MAX_TOKENS = 1024;

/** The request body for one call: fixed system text, forced single tool call, optional picture. */
function body(
  system: string,
  tools: readonly ReviewerTool[],
  text: string,
  screenshot: string | null,
): Anthropic.MessageCreateParamsNonStreaming {
  const content: Anthropic.ContentBlockParam[] = [];
  if (screenshot !== null)
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: screenshot },
    });
  content.push({ type: "text", text });
  return {
    model: REVIEWER_MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    })),
    // Why: one tool call and no free text (section 5 §11.2, "one action, never a list").
    tool_choice: { type: "any", disable_parallel_tool_use: true },
    thinking: { type: "disabled" },
    messages: [{ role: "user", content }],
  };
}

/** The model's one tool call in an API message, or null when it made none. */
function toolCall(msg: Anthropic.Message): { name: string; input: unknown } | null {
  const use = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  return use === undefined ? null : { name: use.name, input: use.input };
}

/** The Claude reviewer. */
export class ClaudeReviewer implements Reviewer {
  readonly #opts: ClaudeOptions;

  constructor(opts: ClaudeOptions) {
    this.#opts = opts;
  }

  /** Proposes one action for one stuck step, or gives up. Bad output is `invalid_output`. */
  async fixStep(
    input: Masked<ReviewerInput>,
    record: CallRecorder,
    signal?: AbortSignal,
  ): Promise<Outcome<ReviewerOutput, CallFailure>> {
    const request = body(FIX_SYSTEM, FIX_TOOLS, fixMessage(input), input.screenshot);
    const sent = await sendRecorded(
      this.#opts,
      request,
      record,
      this.#opts.timeoutMs ?? CALL_TIMEOUT_MS,
      signal,
    );
    if (!sent.ok) return sent;
    if (sent.value.stop_reason === "refusal") return fail("refused");
    const out = fixOutputOf(toolCall(sent.value));
    return out === null ? fail("invalid_output") : ok(out);
  }

  /** Gives a second opinion on a reconciliation check. No action, no screenshot. */
  async secondOpinion(
    input: Masked<JevReconcileInput>,
    record: CallRecorder,
    signal?: AbortSignal,
  ): Promise<Outcome<JevReconcileOutputType, CallFailure>> {
    const request = body(OPINION_SYSTEM, OPINION_TOOLS, opinionMessage(input), null);
    const sent = await sendRecorded(
      this.#opts,
      request,
      record,
      this.#opts.timeoutMs ?? CALL_TIMEOUT_MS,
      signal,
    );
    if (!sent.ok) return sent;
    if (sent.value.stop_reason === "refusal") return fail("refused");
    const call = toolCall(sent.value);
    const parsed = JevReconcileOutput.safeParse(call?.name === "answer" ? call.input : null);
    return parsed.success ? ok(parsed.data) : fail("invalid_output");
  }
}
