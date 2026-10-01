// `intyy major show | deprecate | seal | approve <app>/<capability>@<major>`: the major record that
// deprecates one capability major. Follows design section 9 §9.6 and section 8 §11.9. The reason comes
// from standard input, never a flag (docs/decisions.md, M04). The record is a sealed document like any
// other: `deprecate` writes the candidate, `seal` and `approve` give it force (four eyes, section 9 §6.4).
import type { Command } from "commander";
import { majorKind } from "../../core/model/kinds.js";
import { checkMajor, majorId, type Major } from "../../core/model/major.js";
import { majorStatus } from "../../core/trust/majors.js";
import { requireRole, type Ctx } from "../context.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer } from "../output.js";
import { act, type Register } from "../program.js";
import { approveDoc, load, orExit, revOption, sealDoc, type DocTarget } from "./documents.js";
import { stdinText } from "./trust-approval.js";
import { driftTenants } from "./trust-shared.js";

/** Parses `<app>/<capability>@<major>`. */
function parseSpec(text: string | undefined): { app: string; capability: string; major: number } {
  const m = /^([a-z][a-z0-9_-]*)\/([a-z][a-z0-9_]*)@([1-9]\d*)$/.exec(text ?? "");
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) {
    throw new CliExit(EXIT.usage, "name a major like kvfcu/open_share_subaccount@1");
  }
  return { app: m[1], capability: m[2], major: Number(m[3]) };
}

/** The record of one major. Shared by every tenant, so roles sit on `*` (like faults and thresholds). */
function target(ctx: Ctx, spec: { app: string; capability: string; major: number }): DocTarget<Major> {
  const id = majorId(spec);
  return { store: ctx.wiring.majors, kind: majorKind, id, label: `major ${id}`, scope: "*" };
}

const validate = (doc: Major): Promise<string[]> => Promise.resolve(checkMajor(doc));

/** A whole number from a flag, or a usage error naming it. */
function numberFlag(opts: Record<string, unknown>, name: string, flag: string): number {
  const v = opts[name];
  if (typeof v !== "string" || !/^[1-9]\d*$/.test(v)) throw new CliExit(EXIT.usage, `${flag} takes a major number, like ${flag} 2`);
  return Number(v);
}

/** Registers the `major` commands. */
export const registerMajor: Register = (program: Command, ctxOf) => {
  const major = program.command("major").description("deprecate and retire capability majors");

  major
    .command("show")
    .argument("<major>", "app/capability@major, like kvfcu/open_share_subaccount@1")
    .description("the major record, and each tenant's retire date")
    .action(
      act(ctxOf, async (ctx, args) => {
        const spec = parseSpec(args[0]);
        const t = target(ctx, spec);
        const got = await load(t, ["approved", "sealed", "candidate"]);
        if (!got) return answer({ major: t.id, record: null, tenants: [] }, `${t.id} has no major record. It is not deprecated.`);
        const rows: { tenant: string; successor_approved_here: boolean; retires_on: string | null }[] = [];
        // Why the approved record only: a sealed or candidate record has no force yet (section 8 §11.9).
        if (got.state === "approved") {
          for (const tenant of await driftTenants(ctx)) {
            const status = await majorStatus({ majors: ctx.wiring.majors, scores: ctx.wiring.scores }, tenant, undefined, spec.app, spec.capability, spec.major);
            rows.push({ tenant, successor_approved_here: status?.retiresOn != null, retires_on: status?.retiresOn ?? null });
          }
        }
        const d = got.doc;
        const text = [
          `${t.id} rev ${got.rev} (${got.state}): deprecated on ${d.deprecated_on} by ${d.by}`,
          `successor  @${String(d.successor)}`,
          `retires on ${d.retires_on} at the earliest`,
          `reason     ${d.reason}`,
          ...rows.map((r) => `${r.tenant.padEnd(10)} ${r.retires_on === null ? "successor not approved here: no retire date" : `retires ${r.retires_on}`}`),
        ];
        return answer({ major: t.id, rev: got.rev, state: got.state, record: d, tenants: rows }, text.join("\n"));
      }),
    );

  major
    .command("deprecate")
    .argument("<major>", "app/capability@major, like kvfcu/open_share_subaccount@1")
    .requiredOption("--successor <major>", "the major callers move to, like 2")
    .requiredOption("--retires-on <date>", "the earliest retire day, like 2027-01-31")
    .description("write the next revision of the major record as a candidate (approver on *); the reason comes from standard input")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const staff = requireRole(ctx, "*", "approver");
        const spec = parseSpec(args[0]);
        const t = target(ctx, spec);
        const successor = numberFlag(opts, "successor", "--successor");
        const retires = opts.retiresOn;
        if (typeof retires !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(retires)) throw new CliExit(EXIT.usage, "--retires-on takes a date, like 2027-01-31");
        const reason = await stdinText(ctx, "Reason: ");
        if (reason === "") throw new CliExit(EXIT.usage, "give a reason: pipe it on standard input");
        const base = await load(t, ["candidate", "approved", "sealed"]);
        const doc = {
          schema: "intyy.major/1.0",
          ...spec,
          revision: base === undefined ? 1 : base.state === "candidate" ? base.doc.revision : base.doc.revision + 1,
          deprecated_on: ctx.wiring.clock.now().toISOString().slice(0, 10),
          successor,
          retires_on: retires,
          by: staff,
          reason,
        };
        const parsed = majorKind.parse(doc);
        if (!parsed.success) throw new CliExit(EXIT.invalid, `${t.label}: ${parsed.error.message}`);
        const problems = checkMajor(parsed.data);
        if (problems.length > 0) throw new CliExit(EXIT.invalid, `${t.label}:\n${problems.join("\n")}`);
        orExit(await t.store.putCandidate(t.id, parsed.data, staff), `${t.label} candidate`);
        return answer(
          { document: t.label, rev: String(parsed.data.revision), state: "candidate" },
          `${t.label} candidate ${String(parsed.data.revision)} saved. Seal it with: intyy major seal ${t.id}`,
        );
      }),
    );

  major
    .command("seal")
    .argument("<major>", "app/capability@major")
    .description("freeze the candidate as a sealed revision (reviewer on *)")
    .action(act(ctxOf, (ctx, args) => sealDoc(ctx, target(ctx, parseSpec(args[0])), validate)));

  major
    .command("approve")
    .argument("<major>", "app/capability@major")
    .requiredOption("--rev <n>", "the sealed revision to approve")
    .description("stamp a sealed revision (approver on *, never its sealer)")
    .action(act(ctxOf, (ctx, args, opts) => approveDoc(ctx, target(ctx, parseSpec(args[0])), revOption(opts))));
};
