// Builds a planner cassette from a run folder's `llm/` files: each request's turn text and its
// reply. Reads no secrets. Follows design section 9 §16 ("Planner cassette") and §5.3 (llm files).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { replyOf } from "../src/adapters/claude/planner.js";
import { sha256Hex } from "../src/core/model/canonical.js";
import { Cassette } from "../src/core/model/cassette.js";

/** The prompt version the run froze: `run_start` in `events.jsonl` records it (section 3 §6.5). */
function frozenPrompt(runDir: string): string {
  const first = readFileSync(join(runDir, "events.jsonl"), "utf8").split("\n")[0] ?? "";
  const line = JSON.parse(first) as { data?: { frozen?: { models?: { prompt?: unknown } } } };
  const prompt = line.data?.frozen?.models?.prompt;
  if (typeof prompt !== "string") throw new Error("run_start records no prompt version");
  return prompt;
}

/**
 * The cassette of a run: each planner request's turn text, and its reply. The prompt label comes
 * from the run's own `run_start` unless the caller names one.
 */
export function cassetteOf(runDir: string, runId: string, prompt?: string): Cassette {
  const llm = join(runDir, "llm");
  const names = readdirSync(llm).sort();
  const turns: Cassette["turns"] = [];
  let system = "";
  let model = "";
  for (const name of names.filter((n) => n.endsWith("_planner_request.json"))) {
    const replyName = name.replace("_request.json", "_reply.json");
    // Why: a request with no reply is a failed call; the loop retried it as `<seq>_2_…`.
    if (!names.includes(replyName)) continue;
    const req = JSON.parse(readFileSync(join(llm, name), "utf8")) as Anthropic.MessageCreateParams;
    const sys = Array.isArray(req.system)
      ? req.system.map((b) => b.text).join("")
      : (req.system ?? "");
    const content = req.messages[0]?.content;
    const text = Array.isArray(content) ? content.find((c) => c.type === "text") : undefined;
    const raw = JSON.parse(readFileSync(join(llm, replyName), "utf8")) as { type?: unknown };
    // Why: an API error reply is a failed call; the loop retried it, so it is not a turn.
    if (raw.type !== "message") continue;
    const reply = replyOf(raw as Anthropic.Message);
    if (text?.type !== "text" || reply === "refused")
      throw new Error(`${name}: not a replayable turn`);
    system = sys;
    model = req.model;
    turns.push({ message: text.text, reply });
  }
  return Cassette.parse({
    schema: "intyy.cassette/1.0",
    run_id: runId,
    model,
    prompt: prompt ?? frozenPrompt(runDir),
    system: `sha256:${sha256Hex(system)}`,
    turns,
  });
}
