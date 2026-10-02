// Proves the Claude adapter's model call order with a fake HTTP layer: the stored bytes equal the
// sent bytes, a failed write stops the call, and failures map to ModelFailure. No network is used.
// Design section 9 §5.3 and §16 ("Model call order"); section 6 §11.3; M03 task 7.
import { describe, expect, test } from "vitest";
import { ClaudePlanner, requestBody } from "../../../src/adapters/claude/planner.js";
import { maskedTurn } from "../../../src/core/safety/redaction/compose.js";
import { toolDefinitions } from "../../../src/core/discovery/tools.js";
import type { Masked } from "../../../src/ports/masked.js";
import type { PlannerTurn } from "../../../src/ports/models.js";
import type { Png } from "../../../src/ports/surface.js";

/** A turn with a tiny fake picture. */
function turn(image: boolean): Masked<PlannerTurn> {
  return maskedTurn({
    model: "claude-sonnet-5",
    prompt: "discovery@1.0",
    system: "You operate a test app." as Masked<string>,
    tools: toolDefinitions("discovery"),
    message: '<screen location="/">e1 button "Go"</screen>' as Masked<string>,
    image: image ? (new Uint8Array([0x89, 0x50, 0x4e, 0x47]) as Masked<Png>) : null,
  });
}

/** An API reply with one tool call. */
const REPLY = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [
    {
      type: "tool_use",
      id: "tu_1",
      name: "click",
      input: { element: "e1", reason: "Go.", expected: "Next.", tag: "flow_step" },
    },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 30 },
};

/** A fake fetch that records what it was sent and answers `status` with `body`. */
function fakeFetch(status = 200, body: unknown = REPLY) {
  const sent: Uint8Array[] = [];
  const f: typeof fetch = (_url, init) => {
    const b = init?.body;
    sent.push(
      typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b as ArrayBuffer),
    );
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { f, sent };
}

/** A recorder that keeps what it was asked to write. */
function recorder(okWrites = true) {
  const stored: { part: string; bytes: Uint8Array }[] = [];
  const record = (part: "request" | "reply", bytes: Uint8Array) => {
    stored.push({ part, bytes: new Uint8Array(bytes) });
    return Promise.resolve(okWrites);
  };
  return { record, stored };
}

const planner = (f: typeof fetch) =>
  new ClaudePlanner({ apiKey: "test-key", fetch: f, baseURL: "http://127.0.0.1:9" });

describe("model call order (section 9 §5.3)", () => {
  test("the planner stores the request before the reply, sends nothing after a failed write, and never stores the key", async () => {
    // the stored request bytes equal the sent bytes; the reply is stored as received
    {
      const { f, sent } = fakeFetch();
      const { record, stored } = recorder();
      const r = await planner(f).next(turn(true), record);
      expect(r).toMatchObject({
        ok: true,
        value: {
          call: { name: "click" },
          model: "claude-sonnet-5",
          usage: { input_tokens: 120, output_tokens: 30 },
        },
      });
      expect(stored.map((s) => s.part)).toEqual(["request", "reply"]);
      expect(sent).toHaveLength(1);
      expect(Buffer.from(stored[0]?.bytes ?? []).equals(Buffer.from(sent[0] ?? []))).toBe(true);
      expect(JSON.parse(new TextDecoder().decode(stored[1]?.bytes))).toEqual(REPLY);
    }
    // a failed write stops the call: nothing is sent
    {
      const { f, sent } = fakeFetch();
      const { record } = recorder(false);
      const r = await planner(f).next(turn(false), record);
      expect(r).toMatchObject({ ok: false, failure: "write_failed" });
      expect(sent).toHaveLength(0);
    }
    // the API key never lands in the stored bytes
    {
      const { f } = fakeFetch();
      const { record, stored } = recorder();
      await planner(f).next(turn(false), record);
      for (const s of stored) expect(new TextDecoder().decode(s.bytes)).not.toContain("test-key");
    }
  });
});

describe("failures (section 9 §5.3)", () => {
  test("the planner maps HTTP errors, a network error, and a refusal to failures", async () => {
    // HTTP 429, 500, and 529 are unavailable, with no SDK retry
    for (const status of [429, 500, 529]) {
      const { f, sent } = fakeFetch(status, {
        type: "error",
        error: { type: "overloaded_error", message: "busy" },
      });
      const r = await planner(f).next(turn(false), recorder().record);
      expect(r, `HTTP ${String(status)}`).toMatchObject({ ok: false, failure: "unavailable" });
      expect(sent, `HTTP ${String(status)}`).toHaveLength(1);
    }
    // a network error is unavailable
    {
      const f: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
      const r = await planner(f).next(turn(false), recorder().record);
      expect(r).toMatchObject({ ok: false, failure: "unavailable" });
    }
    // a refusal is refused; a reply with no tool call has call null
    {
      const refusal = fakeFetch(200, { ...REPLY, content: [], stop_reason: "refusal" });
      expect(await planner(refusal.f).next(turn(false), recorder().record)).toMatchObject({
        ok: false,
        failure: "refused",
      });
      const text = fakeFetch(200, {
        ...REPLY,
        content: [{ type: "text", text: "Hmm." }],
        stop_reason: "end_turn",
      });
      expect(await planner(text.f).next(turn(false), recorder().record)).toMatchObject({
        ok: true,
        value: { call: null },
      });
    }
  });
});

describe("request body (section 6 §11.3)", () => {
  test("one required tool call, cached system prompt, no sampling settings, the picture first", () => {
    const body = requestBody(turn(true));
    expect(body.tool_choice).toEqual({ type: "any", disable_parallel_tool_use: true });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect("temperature" in body).toBe(false);
    expect(body.system).toEqual([
      { type: "text", text: "You operate a test app.", cache_control: { type: "ephemeral" } },
    ]);
    const content = body.messages[0]?.content;
    expect(Array.isArray(content) ? content.map((c) => c.type) : null).toEqual(["image", "text"]);
    for (const t of body.tools ?? [])
      expect("$schema" in (t as { input_schema: object }).input_schema).toBe(false);
  });
});
