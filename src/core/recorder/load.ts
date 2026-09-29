// Builds a run's recorder input from its finished run folder, through the store ports only
// (section 6 §14.1: `candidate new` and `discover`'s end-of-run step both feed the recorder
// from a run folder, not from memory). Every read is best effort: a snapshot `readFile` cannot
// find is left out, and the recorder raises its own blocking issue instead of a guess
// (CLAUDE.md: expected trouble is a value, never invented).
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { EvidenceStore, RunFolder } from "../../ports/stores.js";
import type { RunSpec } from "../model/runspec.js";
import { collectA11yFiles } from "./collect.js";
import type { RunLines } from "./record.js";
import type { Snapshots } from "./steps.js";

/** The `llm_decision` line that named `tool`'s proof, with its own log `seq` (docs/decisions.md,
 * M04): the matching `llm/<seq>_planner_request.json` file holds the masked element list the
 * proof IDs point into (section 6 §14.5). Mirrors `collect.ts`'s `collectProof`, which drops
 * the `seq` a fresh run folder still needs. */
function findProofLine(
  rawLines: readonly unknown[],
  tool: "done" | "report_outcome",
): { turn: number; seq: number; ids: readonly string[] } | null {
  for (const raw of rawLines) {
    if (typeof raw !== "object" || raw === null) continue;
    const line = raw as Record<string, unknown>;
    if (line.event !== "llm_decision" || typeof line.seq !== "number" || typeof line.step !== "string") {
      continue;
    }
    const data = line.data;
    if (typeof data !== "object" || data === null) continue;
    const action = (data as Record<string, unknown>).action;
    if (typeof action !== "object" || action === null) continue;
    if ((action as Record<string, unknown>).type !== tool) continue;
    const input = (action as Record<string, unknown>).input;
    const proof =
      typeof input === "object" && input !== null ? (input as Record<string, unknown>).proof : undefined;
    if (!Array.isArray(proof) || !proof.every((p): p is string => typeof p === "string")) continue;
    const m = /^t(\d+)$/.exec(line.step);
    if (m?.[1] === undefined) continue;
    return { turn: Number(m[1]), seq: line.seq, ids: proof };
  }
  return null;
}

/** The masked turn text an `llm/<seq>_planner_request.json` file's one user message held
 * (section 9 §5.3, section 6 §11.2), or `null` when the bytes do not fit that shape. */
function elementListText(bytes: Uint8Array): string | null {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const messages: unknown = (body as Record<string, unknown>).messages;
  const first: unknown = Array.isArray(messages) ? (messages as unknown[])[0] : undefined;
  const content: unknown =
    typeof first === "object" && first !== null ? (first as Record<string, unknown>).content : undefined;
  if (!Array.isArray(content)) return null;
  for (const block of content as unknown[]) {
    if (typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text") {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
  }
  return null;
}

/** Reads back every snapshot the recorder's step and outcome rules need (section 6 §14.5): each
 * turn's masked accessibility snapshot, and the proof call's masked element list. */
export async function loadSnapshots(
  folder: RunFolder,
  rawLines: readonly unknown[],
  tool: "done" | "report_outcome",
  signal?: AbortSignal,
): Promise<Snapshots> {
  const a11yByTurn = new Map<number, string>();
  for (const [turn, file] of collectA11yFiles(rawLines)) {
    const read = await folder.readFile(file, signal);
    if (read.ok) a11yByTurn.set(turn, new TextDecoder().decode(read.value));
  }
  const proofLine = findProofLine(rawLines, tool);
  if (proofLine === null) return { a11yByTurn, proof: null, proofElementListText: null };
  const seq = String(proofLine.seq).padStart(5, "0");
  const read = await folder.readFile(`llm/${seq}_planner_request.json`, signal);
  return {
    a11yByTurn,
    proof: { turn: proofLine.turn, ids: proofLine.ids },
    proofElementListText: read.ok ? elementListText(read.value) : null,
  };
}

/**
 * Reads one finished run's masked log and saved snapshots into {@link RunLines} (section 6
 * §14.1). `spec` is the run's own spec file: a run folder keeps only a masked summary of it
 * (docs/decisions.md, M04), so the caller reads the real one from `library/specs/`.
 */
export async function loadRunLines(
  evidence: EvidenceStore,
  tenant: string,
  runId: string,
  spec: RunSpec,
  tool: "done" | "report_outcome",
  signal?: AbortSignal,
): Promise<Outcome<RunLines, "not_found" | "invalid">> {
  const opened = await evidence.openRun(tenant, runId, signal);
  if (!opened.ok) return fail("not_found", `run ${runId} has no folder`);
  const events = await evidence.events(tenant, runId, signal);
  if (!events.ok) return events;
  const snapshots = await loadSnapshots(opened.value, events.value, tool, signal);
  return ok({ runId, spec, lines: events.value, snapshots });
}
