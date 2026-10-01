// `intyy operator list | show | claim | release | dialog | decide`: the operator's side of the
// mailbox. Follows design section 9 §10.4 (operator commands), §10.5 (mailbox records), section 7
// §13.1 to §13.3 (request fields, decisions, deadlines), and section 4 §7.7 (the approval answers).
// Free text (the release note) comes from standard input, never a flag (docs/decisions.md, M07).
import { join } from "node:path";
import type { Command } from "commander";
import { ClaimFile, Intervention } from "../../core/model/mailbox.js";
import { RunId } from "../../core/model/ids.js";
import { fact, Redactor, redactionRules } from "../../core/safety/redaction/redactor.js";
import { requireRole, requireStaff, type Ctx } from "../context.js";
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

/** The staff ID in a `claim.json`, or null when nobody has claimed. */
function claimedBy(claim: unknown): string | null {
  const c = ClaimFile.safeParse(claim);
  return c.success ? c.data.staff_id : null;
}

/** One request as a short line for `list`. `claimedBy` is `-` while nobody holds it. */
function listLine(runId: string, r: Intervention, by: string | null): string {
  return [
    runId,
    r.capability,
    r.kind,
    r.reason,
    r.step.id,
    r.deadline ?? "no deadline",
    by ?? "-",
  ].join("  ");
}

/** Only a takeover the run can take back (it holds a free lease) may be claimed (section 7 §12.2). */
function requireClaimable(runId: string, r: Intervention): void {
  if (r.kind !== "takeover" || r.lease !== "nobody")
    throw new CliExit(EXIT.usage, `run ${runId}: this request cannot be claimed`);
}

/** The claim must exist and belong to `staff` (section 9 §10.4: release and dialog need it). */
function requireOwnClaim(runId: string, claim: unknown, staff: string): void {
  const by = claimedBy(claim);
  if (by === null)
    throw new CliExit(EXIT.refused, `run ${runId}: claim it first with intyy operator claim ${runId}`);
  if (by !== staff) throw new CliExit(EXIT.refused, `run ${runId}: ${by} holds the claim, not ${staff}`);
}

/** A Redactor for the effective policy, so a note or a body leaves masked (section 9 §10.5). */
async function redactorFor(ctx: Ctx): Promise<Redactor> {
  const policy = await effectivePolicy(ctx, undefined);
  return new Redactor(redactionRules(policy.effective));
}

/** Registers the operator commands. */
export const registerOperator: Register = (program: Command, ctxOf) => {
  const operator = program.command("operator").description("answer a run's open request");

  operator
    .command("list")
    .option("--mine", "only requests claimed by me")
    .description("open requests of this tenant: run, capability, kind, reason, step, deadline, claimed by")
    .action(
      act(ctxOf, async (ctx, _args, opts) => {
        const mine = opts.mine === true ? requireStaff(ctx) : null;
        const open: {
          run_id: string;
          request: Intervention;
          decided: boolean;
          claimed_by: string | null;
        }[] = [];
        for (const row of await latestRows(ctx)) {
          if (row.status !== "escalated") continue;
          const got = await ctx.wiring.desk.openRequest(ctx.tenant, row.run_id);
          if (!got.ok || got.value === null) continue;
          const req = Intervention.safeParse(got.value.request);
          if (!req.success) continue;
          const by = claimedBy(got.value.claim);
          if (mine !== null && by !== mine) continue;
          open.push({
            run_id: row.run_id,
            request: req.data,
            decided: got.value.decided,
            claimed_by: by,
          });
        }
        const lines = open.map(
          (o) => listLine(o.run_id, o.request, o.claimed_by) + (o.decided ? "  (decided)" : ""),
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
          `claimed by: ${claimedBy(o.claim) ?? "nobody"}`,
          `decisions: ${r.decisions.join(" | ")}`,
          ...(o.decided ? ["A decision is already written. The run reads it next."] : []),
          `Answer with: intyy operator decide ${runId} <decision>`,
        ];
        return answer(
          {
            run_id: runId,
            folder: o.folder,
            request: r,
            screenshot: shot,
            decided: o.decided,
            claimed_by: claimedBy(o.claim),
          },
          lines.join("\n"),
        );
      }),
    );

  operator
    .command("decide")
    .argument("<run_id>", "the run to answer")
    .argument("<decision>", "one of the request's allowed decisions")
    .option("--outcome <code>", "for set_outcome: one of the request's declared outcome codes")
    .description(
      "answer the open request (operator); a takeover needs your claim first; a second answer is refused",
    )
    .action(
      act(ctxOf, async (ctx, args, opts) => {
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
        // Why: section 9 §10.4, `decide` needs a claim on a takeover the run can hand back.
        if (o.req.kind === "takeover" && o.req.lease === "nobody")
          requireOwnClaim(runId, o.claim, staff);
        // Why: section 9 §10.4, `set_outcome` checks the declared outcome codes. The flag takes a
        // code, an allow-listed value (docs/decisions.md, M07), never member data.
        const outcome = typeof opts.outcome === "string" ? opts.outcome : null;
        if (decision === "set_outcome") {
          if (outcome === null || !o.req.outcomes.includes(outcome))
            throw new CliExit(
              EXIT.usage,
              `set_outcome: write --outcome with one of ${o.req.outcomes.join(", ")}`,
            );
        } else if (outcome !== null) {
          throw new CliExit(EXIT.usage, `--outcome goes only with set_outcome`);
        }
        const r = await redactorFor(ctx);
        const body = r.value({
          schema: "intyy.decision/1.0",
          staff_id: staff,
          at: fact(ctx.wiring.clock.now().toISOString()),
          decision,
          outcome: outcome === null ? null : fact(outcome),
          note: null,
        });
        const w = await ctx.wiring.desk.decide(ctx.tenant, runId, o.folder, body);
        if (!w.ok && w.failure === "already_decided")
          throw new CliExit(EXIT.refused, `run ${runId}: this request already has a decision`);
        if (!w.ok) throw new CliExit(EXIT.usage, `run ${runId}: the decision could not be written`);
        return answer(
          { run_id: runId, folder: o.folder, decision, outcome, staff_id: staff },
          `run ${runId}: ${decision} recorded by ${staff}.`,
        );
      }),
    );

  operator
    .command("claim")
    .argument("<run_id>", "the run whose takeover to claim")
    .description("take a takeover (operator); the first claimer wins, a second exits 6")
    .action(
      act(ctxOf, async (ctx, args) => {
        const runId = runArg(args);
        const staff = requireRole(ctx, ctx.tenant, "operator");
        const o = await openFor(ctx, runId);
        requireClaimable(runId, o.req);
        const holder = claimedBy(o.claim);
        if (holder !== null)
          throw new CliExit(EXIT.refused, `run ${runId}: already claimed by ${holder}`);
        const r = await redactorFor(ctx);
        const body = r.value({
          schema: "intyy.claim/1.0",
          staff_id: staff,
          at: fact(ctx.wiring.clock.now().toISOString()),
          implicit: false,
        });
        const w = await ctx.wiring.desk.claim(ctx.tenant, runId, o.folder, body);
        // Why exit 6: section 9 §10.5, a second claimer is refused, even in a race.
        if (!w.ok && w.failure === "already_claimed")
          throw new CliExit(EXIT.refused, `run ${runId}: already claimed`);
        if (!w.ok) throw new CliExit(EXIT.usage, `run ${runId}: the claim could not be written`);
        return answer(
          { run_id: runId, folder: o.folder, staff_id: staff },
          `run ${runId}: claimed by ${staff}. Use the visible browser, then: intyy operator release ${runId}`,
        );
      }),
    );

  operator
    .command("release")
    .argument("<run_id>", "the run to hand back")
    .description(
      "hand the browser back (claimer); a piped standard input becomes the note; the bot then reverifies",
    )
    .action(
      act(ctxOf, async (ctx, args) => {
        const runId = runArg(args);
        const staff = requireRole(ctx, ctx.tenant, "operator");
        const o = await openFor(ctx, runId);
        requireClaimable(runId, o.req);
        requireOwnClaim(runId, o.claim, staff);
        if (o.released) throw new CliExit(EXIT.refused, `run ${runId}: already released`);
        const note = ctx.io.stdin.isTTY === true ? "" : (await ctx.io.stdin.readAll()).trim();
        const r = await redactorFor(ctx);
        const body = r.value({
          schema: "intyy.release/1.0",
          staff_id: staff,
          at: fact(ctx.wiring.clock.now().toISOString()),
          note: note === "" ? null : note,
        });
        const w = await ctx.wiring.desk.release(ctx.tenant, runId, o.folder, body);
        if (!w.ok && w.failure === "already_released")
          throw new CliExit(EXIT.refused, `run ${runId}: already released`);
        if (!w.ok) throw new CliExit(EXIT.usage, `run ${runId}: the release could not be written`);
        return answer(
          { run_id: runId, folder: o.folder, staff_id: staff },
          `run ${runId}: released by ${staff}. The bot checks the screen, then continues.`,
        );
      }),
    );

  operator
    .command("dialog")
    .argument("<run_id>", "the run whose native dialog to answer")
    .argument("<answer>", "accept or dismiss")
    .description("answer a native dialog during your takeover (claimer); the run clicks it for you")
    .action(
      act(ctxOf, async (ctx, args) => {
        const runId = runArg(args);
        const choice = args[1] ?? "";
        if (choice !== "accept" && choice !== "dismiss")
          throw new CliExit(EXIT.usage, `answer ${choice}: write accept or dismiss`);
        const staff = requireRole(ctx, ctx.tenant, "operator");
        const o = await openFor(ctx, runId);
        requireClaimable(runId, o.req);
        requireOwnClaim(runId, o.claim, staff);
        const r = await redactorFor(ctx);
        const line = r.value({
          staff_id: staff,
          at: fact(ctx.wiring.clock.now().toISOString()),
          answer: choice,
        });
        const w = await ctx.wiring.desk.dialog(ctx.tenant, runId, o.folder, line);
        if (!w.ok) throw new CliExit(EXIT.usage, `run ${runId}: the answer could not be written`);
        return answer(
          { run_id: runId, folder: o.folder, staff_id: staff, answer: choice },
          `run ${runId}: dialog ${choice} recorded by ${staff}.`,
        );
      }),
    );
};
