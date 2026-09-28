// Builds a planner cassette from a run folder's `llm/` files: each request's turn text and its
// reply. Reads no secrets. Follows design section 9 §16 ("Planner cassette") and §5.3 (llm files).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { replyOf } from "../src/adapters/claude/planner.js";
import { sha256Hex } from "../src/core/model/canonical.js";
import { Cassette } from "../src/core/model/cassette.js";

/** The cassette of a run: each planner request's turn text, and its reply. */
export function cassetteOf(runDir: string, runId: string, prompt = "discovery@1.0"): Cassette {
  const llm = join(runDir, "llm");
  const names = readdirSync(llm).sort();
  const turns: Cassette["turns"] = [];
  let system = "";
  let model = "";
  for (const name of names.filter((n) => n.endsWith("_planner_request.json"))) {
    const replyName = name.replace("_request.json", "_reply.json");
    // Why: a request with no reply is a failed call; the loop retried it under a new number.
    if (!names.includes(replyName)) continue;
    const req = JSON.parse(readFileSync(join(llm, name), "utf8")) as Anthropic.MessageCreateParams;
    const sys = Array.isArray(req.system)
      ? req.system.map((b) => b.text).join("")
      : (req.system ?? "");
    const content = req.messages[0]?.content;
    const text = Array.isArray(content) ? content.find((c) => c.type === "text") : undefined;
    const reply = replyOf(
      JSON.parse(readFileSync(join(llm, replyName), "utf8")) as Anthropic.Message,
    );
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
    prompt,
    system: `sha256:${sha256Hex(system)}`,
    turns,
  });
}
