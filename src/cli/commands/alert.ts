// `intyy alert list | show | act | dismiss` and `intyy drift report [--since <date>]`.
// Follows design section 9 §9.7 and section 8 §13.1 to §13.3. What was done, and why not, come from
// standard input, never a flag (docs/decisions.md, M04: input values never go on a flag).
import type { Command } from "commander";
import type { Alert } from "../../core/model/alert.js";
import { closeAlert, gatherFacts, type CloseFailure } from "../../core/trust/alerts.js";
import { allFindings, since, type Finding } from "../../core/trust/drift.js";
import type { Outcome } from "../../ports/outcome.js";
import { requireRole, type Ctx } from "../context.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer } from "../output.js";
import { act, type Register } from "../program.js";
import { stdinText } from "./trust-approval.js";
import { driftDeps, driftTenants } from "./trust-shared.js";

/** The alert states `--state` accepts. */
const STATES = ["open", "acted", "dismissed"] as const;

/** All alerts of this tenant, newest first, or a failed read as an exit. */
async function tenantAlerts(ctx: Ctx): Promise<Alert[]> {
  const all = await ctx.wiring.alerts.list();
  if (!all.ok) throw new CliExit(EXIT.invalid, `alerts: ${all.detail ?? all.failure}`);
  return all.value.filter((a) => a.tenant === ctx.tenant).reverse();
}

/** One list line. */
function line(a: Alert): string {
  return `${a.id}  ${a.state.padEnd(9)}  ${a.pattern.padEnd(17)}  ${a.keys.join(", ")}`;
}

/** Unwraps a close, or ends the command with the failure's exit code. */
function closed(command: string, r: Outcome<Alert, CloseFailure>): Alert {
  if (r.ok) return r.value;
  const code = r.failure === "not_found" ? EXIT.usage : r.failure === "not_open" ? EXIT.refused : EXIT.invalid;
  throw new CliExit(code, `alert ${command}: ${r.detail ?? r.failure}`);
}

/** The text a staff member pipes in: required. */
async function noteText(ctx: Ctx, what: string): Promise<string> {
  const text = await stdinText(ctx, `${what}: `);
  if (text === "") throw new CliExit(EXIT.usage, `${what}: pipe it on standard input`);
  return text;
}

/** Registers the `alert` commands. */
export const registerAlert: Register = (program: Command, ctxOf) => {
  const alert = program.command("alert").description("alerts from the drift reader");

  alert
    .command("list")
    .option("--state <state>", "open (the default), acted, or dismissed")
    .description("alerts of this tenant, newest first")
    .action(
      act(ctxOf, async (ctx, _args, opts) => {
        const want = STATES.find((s) => s === (opts.state ?? "open"));
        if (want === undefined) throw new CliExit(EXIT.usage, "--state: open, acted, or dismissed");
        const rows = (await tenantAlerts(ctx)).filter((a) => a.state === want);
        return answer(rows, rows.length === 0 ? `No ${want} alerts.` : rows.map(line).join("\n"));
      }),
    );

  alert
    .command("show")
    .argument("<id>", "an alert ID, like alert_2026-10-01_3fk8q2m7xa")
    .description("the pattern, keys, evidence runs, and suggested fix")
    .action(
      act(ctxOf, async (ctx, args) => {
        const got = await ctx.wiring.alerts.get(args[0] ?? "");
        if (!got.ok || got.value.tenant !== ctx.tenant) throw new CliExit(EXIT.usage, `no alert ${args[0] ?? ""} for tenant ${ctx.tenant}`);
        const a = got.value;
        const text = [
          line(a),
          `raised     ${a.at}`,
          `what       ${a.detail}`,
          `runs       ${a.evidence_runs.join(", ") || "none"}`,
          `fix        ${a.suggested_fix}`,
          ...(a.closed === null ? [] : [`${a.state}   ${a.closed.by} at ${a.closed.at}: ${a.closed.note}`]),
        ];
        return answer(a, text.join("\n"));
      }),
    );

  alert
    .command("act")
    .argument("<id>", "an alert ID")
    .description("mark an open alert acted (operator); what was done (a draft, batch, pack revision, or note) comes from standard input")
    .action(
      act(ctxOf, async (ctx, args) => {
        const staff = requireRole(ctx, ctx.tenant, "operator");
        const note = await noteText(ctx, "What was done");
        const a = closed("act", await closeAlert(driftDeps(ctx), args[0] ?? "", "acted", staff, note));
        return answer(a, `alert ${a.id} acted`);
      }),
    );

  alert
    .command("dismiss")
    .argument("<id>", "an alert ID")
    .description("mark an open alert dismissed (operator); the reason comes from standard input")
    .action(
      act(ctxOf, async (ctx, args) => {
        const staff = requireRole(ctx, ctx.tenant, "operator");
        const note = await noteText(ctx, "Reason");
        const a = closed("dismiss", await closeAlert(driftDeps(ctx), args[0] ?? "", "dismissed", staff, note));
        return answer(a, `alert ${a.id} dismissed`);
      }),
    );
};

/** One report line per finding, with the open alert that already covers it, if any. */
function findingLine(f: Finding, alertId: string | undefined): string {
  return `${f.pattern}  ${f.keys.join(", ")}\n  ${f.detail}\n  fix: ${f.fix}${alertId === undefined ? "" : `\n  alert: ${alertId}`}`;
}

/** Registers `drift report`. */
export const registerDrift: Register = (program: Command, ctxOf) => {
  const drift = program.command("drift").description("what the drift reader sees");

  drift
    .command("report")
    .option("--since <date>", "only findings whose newest evidence is on or after this date, like 2026-09-30")
    .description("the early warnings, patterns, and change points for this tenant; writes nothing")
    .action(
      act(ctxOf, async (ctx, _args, opts) => {
        const from = opts.since;
        if (from !== undefined && (typeof from !== "string" || !/^\d{4}-\d{2}-\d{2}(T\S*)?$/.test(from))) {
          throw new CliExit(EXIT.usage, "--since: a date like 2026-09-30");
        }
        const found = allFindings(await gatherFacts(driftDeps(ctx), await driftTenants(ctx))).filter((f) => f.tenant === ctx.tenant);
        const rows = typeof from === "string" ? since(found, from) : found;
        const open = (await tenantAlerts(ctx)).filter((a) => a.state === "open");
        const idFor = (f: Finding): string | undefined => open.find((a) => a.fingerprint === f.fingerprint)?.id;
        return answer(
          rows.map((f) => ({ ...f, alert: idFor(f) ?? null })),
          rows.length === 0 ? "No drift found." : rows.map((f) => findingLine(f, idFor(f))).join("\n"),
        );
      }),
    );
};
