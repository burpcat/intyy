// `intyy run status | list | show`: read a run's stored result, or its last known status while
// it is still going. Follows design section 9 §10.2 (waiting, polling, the delivery window),
// §7.5 (exit codes); section 3 §5.13 (a re-read after the delivery window shows masked outputs,
// with warning `outputs_masked`). M05 task 9.
import type { Command } from "commander";
import { RunId } from "../../core/model/ids.js";
import type { Result } from "../../core/model/result.js";
import { RunJson } from "../../core/model/run.js";
import type { Ctx } from "../context.js";
import { CliExit, EXIT, exitForStatus, type RunStatus } from "../exit-codes.js";
import { answer } from "../output.js";
import { act, type Register } from "../program.js";
import { maskOutputsForDelivery, outputLines, outputSensitivity } from "./replay.js";

/** One tenant index line this command reads back. */
type IndexRow = { run_id: string; status: string; capability?: string };

/** The newest index line per run ID, in first-seen order (the index's last status counts). */
async function latestRows(ctx: Ctx): Promise<IndexRow[]> {
  const got = await ctx.wiring.evidence.index(ctx.tenant);
  if (!got.ok) throw new CliExit(EXIT.invalid, `the ${ctx.tenant} run index does not parse`);
  const rows = new Map<string, IndexRow>();
  for (const line of got.value) {
    if (typeof line !== "object" || line === null) continue;
    const l = line as Record<string, unknown>;
    if (typeof l.run_id !== "string" || typeof l.status !== "string") continue;
    rows.set(l.run_id, {
      run_id: l.run_id,
      status: l.status,
      ...(typeof l.capability === "string" ? { capability: l.capability } : {}),
    });
  }
  return [...rows.values()];
}

/** The run ID operand, checked. */
function runArg(args: string[]): string {
  const id = args[0] ?? "";
  if (!RunId.safeParse(id).success) throw new CliExit(EXIT.usage, `run ${id}: not a run ID`);
  return id;
}

/** What one `run status`/`show` read found: the run's final result, or its last known status. */
type RunView = { status: string; final: boolean; result?: Result };

/** Reads `run.json` if the run ended; otherwise the tenant index's last line for it. Once the
 * delivery window ends (in the CLI, once the hosting `replay` process exits), a re-read always
 * goes through the same masked delivery (section 3 §5.13, `maskOutputsForDelivery`), never the
 * values a live run held in memory. */
async function readRun(ctx: Ctx, runId: string): Promise<RunView> {
  const read = await ctx.wiring.evidence.readRunJson(ctx.tenant, runId);
  if (read.ok) {
    const parsed = RunJson.safeParse(read.value);
    if (!parsed.success) throw new CliExit(EXIT.invalid, `run ${runId}: run.json does not fit its schema`);
    // Why only `replay`: a discovery run.json carries no `intyy.result/1.0` block at all.
    if (parsed.data.kind !== "replay") return { status: parsed.data.status, final: true };
    const masked = maskOutputsForDelivery(
      parsed.data.result,
      await outputSensitivity(ctx, parsed.data.result.capability),
    );
    return { status: parsed.data.status, final: true, result: masked };
  }
  const row = (await latestRows(ctx)).find((r) => r.run_id === runId);
  if (row === undefined) throw new CliExit(EXIT.usage, `run ${runId} is not in tenant ${ctx.tenant}`);
  return { status: row.status, final: false };
}

/** A wait duration in milliseconds, from `--wait`. Not an input value: a poll ceiling. */
function waitMsOf(opts: Record<string, unknown>): number {
  if (opts.wait === undefined) return 0;
  if (typeof opts.wait !== "string" || !/^\d+$/.test(opts.wait)) {
    throw new CliExit(EXIT.usage, "--wait takes a number of milliseconds");
  }
  return Number(opts.wait);
}

/** Registers `run`. */
export const registerRun: Register = (program: Command, ctxOf) => {
  const run = program.command("run").description("read a run's stored status and result");

  run
    .command("status")
    .argument("<run_id>", "the run to read")
    .option("--wait <ms>", "poll until the run is final, or this many milliseconds pass")
    .description("the run's stored result; exit 3 while it is not final (section 9 §10.2)")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const runId = runArg(args);
        const deadline = ctx.wiring.clock.now().getTime() + waitMsOf(opts);
        let got = await readRun(ctx, runId);
        while (!got.final && ctx.wiring.clock.now().getTime() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          got = await readRun(ctx, runId);
        }
        if (got.result === undefined) {
          return answer(
            { run_id: runId, status: got.status },
            `run ${runId}: ${got.status}`,
            exitForStatus(got.status as RunStatus),
          );
        }
        return answer(
          got.result,
          [`run ${runId}`, ...outputLines(got.result)].join("\n"),
          exitForStatus(got.result.status),
        );
      }),
    );

  run
    .command("list")
    .description("every run in this tenant, its newest known status")
    .action(
      act(ctxOf, async (ctx) => {
        const rows = await latestRows(ctx);
        const lines = rows.map((r) => [r.run_id, r.status, r.capability ?? ""].join("  "));
        return answer({ runs: rows }, rows.length === 0 ? "No runs." : lines.join("\n"));
      }),
    );

  run
    .command("show")
    .argument("<run_id>", "the run to show")
    .description("the run's full stored result, or its last known status while it runs")
    .action(
      act(ctxOf, async (ctx, args) => {
        const runId = runArg(args);
        const got = await readRun(ctx, runId);
        if (got.result === undefined) {
          return answer({ run_id: runId, status: got.status }, `run ${runId}: ${got.status} (not yet final)`);
        }
        return answer(got.result, [`run ${runId}`, ...outputLines(got.result)].join("\n"));
      }),
    );
};
