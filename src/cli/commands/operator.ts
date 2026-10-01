// `intyy operator list | show | decide`: the operator's side of the mailbox. Claims, releases,
// and dialogs arrive in M07. Follows design section 9 §10.4 (operator commands), §10.5 (mailbox
// records), section 7 §13.1 (request fields), and section 4 §7.7 (the four approval answers).
import { join } from "node:path";
import type { Command } from "commander";
import { Intervention } from "../../core/model/mailbox.js";
import { RunId } from "../../core/model/ids.js";
import { fact, Redactor, redactionRules } from "../../core/safety/redaction/redactor.js";
import { requireRole, type Ctx } from "../context.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer } from "../output.js";
import { act, type Register } from "../program.js";
import { effectivePolicy } from "./policy.js";

/** One run's newest index line. */
type IndexRow = { run_id: string; status: string; capability?: string };

/** The newest index line per run, in first-seen order (section 9 §10.4: the last status counts). */
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

/** The open request of a run, checked against its schema, or an exit. */
async function openFor(ctx: Ctx, runId: string) {
  const got = await ctx.wiring.desk.openRequest(ctx.tenant, runId);
  if (!got.ok) throw new CliExit(EXIT.usage, `run ${runId} is not in tenant ${ctx.tenant}`);
  if (got.value === null) throw new CliExit(EXIT.usage, `run ${runId} has no open request`);
  const req = Intervention.safeParse(got.value.request);
  if (!req.success)
    throw new CliExit(EXIT.invalid, `run ${runId}: request.json does not fit its schema`);
  return { ...got.value, req: req.data };
}

/** One request as a short line for `list`. */
function listLine(runId: string, r: Intervention): string {
  return [runId, r.capability, r.kind, r.reason, r.step.id, r.deadline ?? "no deadline"].join("  ");
}

/** Registers the operator commands. */
export const registerOperator: Register = (program: Command, ctxOf) => {
  const operator = program.command("operator").description("answer a run's open request");

  operator
    .command("list")
    .description("open requests of this tenant: run, capability, kind, reason, step, deadline")
    .action(
      act(ctxOf, async (ctx) => {
        const open: { run_id: string; request: Intervention; decided: boolean }[] = [];
        for (const row of await latestRows(ctx)) {
          if (row.status !== "escalated") continue;
          const got = await ctx.wiring.desk.openRequest(ctx.tenant, row.run_id);
          if (!got.ok || got.value === null) continue;
          const req = Intervention.safeParse(got.value.request);
          if (req.success)
            open.push({ run_id: row.run_id, request: req.data, decided: got.value.decided });
        }
        const lines = open.map(
          (o) => listLine(o.run_id, o.request) + (o.decided ? "  (decided)" : ""),
        );
        return answer(
          { requests: open },
          open.length === 0 ? "No open requests." : lines.join("\n"),
        );
      }),
    );

  operator
    .command("show")
    .argument("<run_id>", "the run whose open request to show")
    .description("the open request, masked, with its screenshot path and allowed decisions")
    .action(
      act(ctxOf, async (ctx, args) => {
        const runId = runArg(args);
        const o = await openFor(ctx, runId);
        const r = o.req;
        const shot = r.screenshot === null ? null : join(o.runDir, r.screenshot);
        const lines = [
          `run ${runId}  ${r.capability}`,
          `${r.kind}: ${r.reason}, step ${r.step.id}`,
          ...(r.approval === null
            ? []
            : [
                `control: "${r.approval.words ?? "(no words)"}", risk ${r.approval.risk}`,
                ...(r.approval.action === undefined
                  ? []
                  : [
                      `action: ${r.approval.action}, rule ${r.approval.rule ?? "unknown"}, path ${r.approval.path ?? "unknown"}`,
                    ]),
                ...(r.approval.detail == null ? [] : [`note: ${r.approval.detail}`]),
              ]),
          ...(r.trouble === null ? [] : [`trouble: ${r.trouble.detail}`]),
          `screenshot: ${shot ?? "none"}`,
          `deadline: ${r.deadline ?? "none"}`,
          `decisions: ${r.decisions.join(" | ")}`,
          ...(o.decided ? ["A decision is already written. The run reads it next."] : []),
          `Answer with: intyy operator decide ${runId} <decision>`,
        ];
        return answer(
          { run_id: runId, folder: o.folder, request: r, screenshot: shot, decided: o.decided },
          lines.join("\n"),
        );
      }),
    );

  operator
    .command("decide")
    .argument("<run_id>", "the run to answer")
    .argument("<decision>", "one of the request's allowed decisions")
    .description("answer the open request (operator); a second answer is refused")
    .action(
      act(ctxOf, async (ctx, args) => {
        const runId = runArg(args);
        const decision = args[1] ?? "";
        const staff = requireRole(ctx, ctx.tenant, "operator");
        const o = await openFor(ctx, runId);
        // Why: section 9 §10.4, decide checks the request's allowed decisions.
        if (!o.req.decisions.includes(decision))
          throw new CliExit(
            EXIT.usage,
            `decision ${decision}: write one of ${o.req.decisions.join(", ")}`,
          );
        const policy = await effectivePolicy(ctx, undefined);
        const r = new Redactor(redactionRules(policy.effective));
        const body = r.value({
          schema: "intyy.decision/1.0",
          staff_id: staff,
          at: fact(ctx.wiring.clock.now().toISOString()),
          decision,
          outcome: null,
          note: null,
        });
        const w = await ctx.wiring.desk.decide(ctx.tenant, runId, o.folder, body);
        if (!w.ok && w.failure === "already_decided")
          throw new CliExit(EXIT.refused, `run ${runId}: this request already has a decision`);
        if (!w.ok) throw new CliExit(EXIT.usage, `run ${runId}: the decision could not be written`);
        return answer(
          { run_id: runId, folder: o.folder, decision, staff_id: staff },
          `run ${runId}: ${decision} recorded by ${staff}.`,
        );
      }),
    );
};
