// The approval family: `trust list | show | history | review | approve | reject | restore |
// reinstate | demote | retire`. Follows design section 9 §9.3 (the screen), §9.4 (the commands),
// and section 8 §10 (approval). The rules are in core/trust; this file gathers facts, calls
// them, and maps refusals to exit codes. Notes and reasons come from standard input, never a flag
// (docs/decisions.md, M04: input values never go on a flag).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { BatchReport } from "../../core/model/batch-report.js";
import { TrustState, type ScoreKey, type ScoreRecord } from "../../core/model/score.js";
import {
  buildReview,
  fragileSteps,
  linkFacts,
  priorApproved,
  refusals,
  sealerOf,
  type ApprovalMove,
  type ReviewFacts,
} from "../../core/trust/approval.js";
import {
  approveKey,
  demoteKey,
  rejectKey,
  reinstateKey,
  restoreKey,
  retireKey,
  type Decider,
  type DecisionFailure,
} from "../../core/trust/decisions.js";
import { capabilityParts, keyPath, keyText } from "../../core/trust/keys.js";
import { recordHash } from "../../core/trust/rebuild.js";
import { renderReview } from "../../core/trust/review-screen.js";
import type { Outcome } from "../../ports/outcome.js";
import { readArtifact } from "../../core/catalog/artifacts.js";
import { requireRole, type Ctx } from "../context.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer } from "../output.js";
import { act, readVersion } from "../program.js";
import { loadFrozenSetFor } from "./pack.js";
import { currentRecord, exitFor, keyFromText, scoreDeps, tenantRecords, whoIs } from "./trust-shared.js";

/** Standard input as text: piped, or one question on a terminal. A terminal with no prompt gives "". */
async function stdinText(ctx: Ctx, prompt: string | null): Promise<string> {
  if (ctx.io.stdin.isTTY === true) return prompt === null ? "" : (await ctx.io.stdin.question(prompt)).trim();
  return (await ctx.io.stdin.readAll()).trim();
}

/** A required reason, from standard input. */
async function reasonText(ctx: Ctx): Promise<string> {
  const reason = await stdinText(ctx, "Reason: ");
  if (reason === "") throw new CliExit(EXIT.usage, "give a reason: pipe it on standard input");
  return reason;
}

/** A required value flag, or a usage error naming it. */
function needed(opts: Record<string, unknown>, name: string, flag: string): string {
  const v = opts[name];
  if (typeof v !== "string" || v === "") throw new CliExit(EXIT.usage, `${flag} is required`);
  return v;
}

/** The deciding person: the role this command needs, the clock, and a lock identity. */
function decider(ctx: Ctx, command: string, staff: string, roles: Decider["roles"]): Decider {
  return {
    at: ctx.wiring.clock.now(),
    staff,
    roles,
    who: { owner: ctx.wiring.ids.batchId(), command: `trust ${command}`, staff: ctx.staff },
  };
}

/** Unwraps a decision, or ends the command with the failure's exit code. */
function done<T>(command: string, r: Outcome<T, DecisionFailure>): T {
  if (!r.ok) throw new CliExit(exitFor(r.failure), `trust ${command}: ${r.detail ?? r.failure}`);
  return r.value;
}

/** Taking trust away needs an operator or an approver (section 8 §10.1). Returns the staff ID and the role that qualified. */
function requireOperatorOrApprover(ctx: Ctx): { staff: string; role: "operator" | "approver" } {
  try {
    return { staff: requireRole(ctx, ctx.tenant, "operator"), role: "operator" };
  } catch (e) {
    if (!(e instanceof CliExit) || e.code !== EXIT.refused) throw e;
    return { staff: requireRole(ctx, ctx.tenant, "approver"), role: "approver" };
  }
}

/** Reads a batch's `report.json` from `state/evidence/<tenant>/batches/<batch>/`; `null` when missing or invalid. */
function readReport(ctx: Ctx, batchId: string): BatchReport | null {
  // Why: the batch ID becomes a path segment, so only plain ID characters pass.
  if (!/^[A-Za-z0-9_-]+$/.test(batchId)) throw new CliExit(EXIT.usage, `--batch ${batchId}: not a batch ID`);
  const path = join(ctx.root, ctx.config.state, "evidence", ctx.tenant, "batches", batchId, "report.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = BatchReport.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Gathers every fact the approval rules read (section 8 §10.3, §10.4). */
async function gather(ctx: Ctx, key: ScoreKey, batchArg: string | undefined): Promise<ReviewFacts> {
  const deps = scoreDeps(ctx);
  const records = await tenantRecords(ctx, deps);
  const record = await currentRecord(deps, key);
  const batchId = batchArg ?? record.certify?.batch ?? null;
  const { name, version } = capabilityParts(key.capability);
  const [app = "", capability = ""] = name.split("/");
  const artifact = await readArtifact(ctx.wiring.candidates, app, capability, version);
  const index = await ctx.wiring.publish.library.read("index.jsonl");
  const frozen = await loadFrozenSetFor(ctx, ctx.tenant, app, key.app_version);
  return {
    key,
    record,
    batchId,
    report: batchId === null ? null : readReport(ctx, batchId),
    now: { engine: readVersion(), handlerSet: frozen.runStart.hash },
    artifactSealed: artifact.ok,
    links: artifact.ok ? linkFacts(artifact.value, records, ctx.tenant, key.app_version) : [],
    sealer: index.ok ? sealerOf(new TextDecoder().decode(index.value), name, version) : null,
    who: whoIs(ctx),
    decisions: artifact.ok ? artifact.value.provenance.decisions : [],
    prior: priorApproved(records, key).map(keyText),
  };
}

/** Throws the refusals of `trust approve` or `trust restore` as one exit 6. */
function refuseIf(command: string, facts: ReviewFacts, move: ApprovalMove, quoted: string, acks: readonly string[]): void {
  const found = refusals(facts, move, quoted, acks);
  if (found.length === 0) return;
  const lines = found.map((r) => `  ${r.code}: ${r.detail}`);
  throw new CliExit(EXIT.refused, `trust ${command} refused:\n${lines.join("\n")}`);
}

/** One line for a record in `trust list`. */
function listLine(r: ScoreRecord): string {
  const since = r.state_since === null ? "" : `   since ${r.state_since} by ${r.state_by ?? "?"}`;
  return `${r.state.padEnd(9)} ${keyText(r.key)}   app ${r.key.app_version}${since}`;
}

/** Registers the approval family under `trust`. */
export function registerApproval(trust: Command, ctxOf: () => Ctx): void {
  trust
    .command("list")
    .option("--state <state>", "only keys in this state: draft, approved, degraded, or retired")
    .description("keys of this tenant that have score files, with their state")
    .action(
      act(ctxOf, async (ctx, _args, opts) => {
        const want = opts.state === undefined ? undefined : TrustState.safeParse(opts.state);
        if (want !== undefined && !want.success) throw new CliExit(EXIT.usage, "--state: draft, approved, degraded, or retired");
        const all = await tenantRecords(ctx, scoreDeps(ctx));
        const rows = all.filter((r) => want === undefined || r.state === want.data);
        return answer(
          rows.map((r) => ({ key: keyText(r.key), app_version: r.key.app_version, state: r.state, since: r.state_since, by: r.state_by })),
          rows.length === 0 ? "No keys." : rows.map(listLine).join("\n"),
        );
      }),
    );

  trust
    .command("show")
    .argument("<key>", "app/capability@x.y.z, with +p<n> for a patch")
    .description("the key's record")
    .action(
      act(ctxOf, async (ctx, args) => {
        const r = await currentRecord(scoreDeps(ctx), await keyFromText(ctx, args[0]));
        const lines = [
          listLine(r),
          `reason     ${r.state_reason ?? "none"}`,
          `batch      ${r.certify === null ? "no full batch" : `${r.certify.batch}   gate ${r.certify.gate}`}`,
          `approval   ${r.approval === null ? "none" : `${r.approval.by} on ${r.approval.batch} at ${r.approval.at}`}`,
          `timeouts   ${r.timeouts.approved_from === null ? "none installed" : `from ${r.timeouts.approved_from}`}`,
          `RECORD ${recordHash(r)}`,
        ];
        return answer({ record: r, hash: recordHash(r) }, lines.join("\n"));
      }),
    );

  trust
    .command("history")
    .argument("<key>", "app/capability@x.y.z, with +p<n> for a patch")
    .description("the key's history lines, oldest first")
    .action(
      act(ctxOf, async (ctx, args) => {
        const key = await keyFromText(ctx, args[0]);
        const lines = await ctx.wiring.scores.history(keyPath(key));
        if (!lines.ok) throw new CliExit(EXIT.invalid, `trust history: ${lines.detail ?? lines.failure}`);
        const text = lines.value.map((l) => `${l.at}  ${l.event.padEnd(9)} ${l.by}   ${l.reason}`);
        return answer(lines.value, text.length === 0 ? "No history." : text.join("\n"));
      }),
    );

  trust
    .command("review")
    .argument("<key>", "app/capability@x.y.z, with +p<n> for a patch")
    .option("--batch <id>", "the batch to review (default: the key's latest full batch)")
    .option("--full", "show every gate rule, every run that was not pass, and more detail")
    .description("the approval screen: what blocks, what needs your note, what to read")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const facts = await gather(ctx, await keyFromText(ctx, args[0]), typeof opts.batch === "string" ? opts.batch : undefined);
        const review = buildReview(facts);
        return answer(review, renderReview(review, opts.full === true));
      }),
    );

  trust
    .command("approve")
    .argument("<key>", "app/capability@x.y.z, with +p<n> for a patch")
    .option("--batch <id>", "the full batch that earned the approval")
    .option("--ack <step...>", "a fragile step you have read; repeat for each")
    .option("--expect-record <hash>", "the record hash the review screen ended with")
    .description("approve a key (approver, not the sealer); a piped standard input becomes the note")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const staff = requireRole(ctx, ctx.tenant, "approver");
        const batch = needed(opts, "batch", "--batch");
        const quoted = needed(opts, "expectRecord", "--expect-record");
        const acks = Array.isArray(opts.ack) ? opts.ack.filter((a): a is string => typeof a === "string") : [];
        const facts = await gather(ctx, await keyFromText(ctx, args[0]), batch);
        const unknown = acks.filter((a) => !fragileSteps(facts.record).includes(a));
        if (unknown.length > 0) throw new CliExit(EXIT.usage, `--ack ${unknown.join(", ")}: not a fragile step of this key`);
        refuseIf("approve", facts, "approve", quoted, acks);
        const note = await stdinText(ctx, null);
        const result = done(
          "approve",
          await approveKey(scoreDeps(ctx), facts.record, decider(ctx, "approve", staff, facts.who?.roles ?? []), {
            batch,
            acknowledged: [...new Set(acks)],
            note: note === "" ? null : note,
            // Why: no batch records the timeouts it ran with yet (task 11), so approval installs the defaults.
            prior: priorApproved(await tenantRecords(ctx, scoreDeps(ctx)), facts.key),
          }),
        );
        const text = [
          `approved ${keyText(facts.key)} on ${batch} by ${staff}`,
          ...result.retired.map((k) => `retired ${k}`),
          `RECORD ${recordHash(result.record)}`,
        ];
        return answer({ key: keyText(facts.key), state: result.record.state, retired: result.retired, record: recordHash(result.record) }, text.join("\n"));
      }),
    );

  trust
    .command("reject")
    .argument("<key>", "app/capability@x.y.z, with +p<n> for a patch")
    .option("--batch <id>", "the batch you reject")
    .description("record a rejection (approver); the key stays as it was; a piped standard input becomes the note")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const staff = requireRole(ctx, ctx.tenant, "approver");
        const batch = needed(opts, "batch", "--batch");
        if (readReport(ctx, batch) === null) throw new CliExit(EXIT.usage, `--batch ${batch}: no report for that batch`);
        const record = await currentRecord(scoreDeps(ctx), await keyFromText(ctx, args[0]));
        const note = await stdinText(ctx, null);
        const result = done(
          "reject",
          await rejectKey(scoreDeps(ctx), record, decider(ctx, "reject", staff, ["approver"]), { batch, note: note === "" ? null : note }),
        );
        return answer({ key: keyText(record.key), state: result.state, record: recordHash(result) }, `rejected ${batch} for ${keyText(record.key)}; the key stays ${result.state}`);
      }),
    );

  trust
    .command("restore")
    .argument("<key>", "app/capability@x.y.z, with +p<n> for a patch")
    .option("--batch <id>", "a new full batch that passed the gate")
    .option("--after-exclusion", "restore after excluded runs, without a new batch (M11)")
    .option("--expect-record <hash>", "the record hash the review screen ended with")
    .description("restore a degraded key (approver); a piped standard input becomes the note")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const staff = requireRole(ctx, ctx.tenant, "approver");
        if (opts.afterExclusion === true) {
          throw new CliExit(EXIT.usage, "--after-exclusion is not built yet; excluded runs arrive in M11");
        }
        const batch = needed(opts, "batch", "--batch");
        const quoted = needed(opts, "expectRecord", "--expect-record");
        const facts = await gather(ctx, await keyFromText(ctx, args[0]), batch);
        refuseIf("restore", facts, "restore", quoted, []);
        const note = await stdinText(ctx, null);
        const result = done(
          "restore",
          await restoreKey(scoreDeps(ctx), facts.record, decider(ctx, "restore", staff, facts.who?.roles ?? []), {
            batch,
            note: note === "" ? null : note,
          }),
        );
        return answer({ key: keyText(facts.key), state: result.state, record: recordHash(result) }, `restored ${keyText(facts.key)} on ${batch}\nRECORD ${recordHash(result)}`);
      }),
    );

  trust
    .command("reinstate")
    .argument("<key>", "app/capability@x.y.z, with +p<n> for a patch")
    .description("send a retired key back to draft (approver); the reason comes from standard input")
    .action(
      act(ctxOf, async (ctx, args) => {
        const staff = requireRole(ctx, ctx.tenant, "approver");
        const record = await currentRecord(scoreDeps(ctx), await keyFromText(ctx, args[0]));
        const reason = await reasonText(ctx);
        const result = done("reinstate", await reinstateKey(scoreDeps(ctx), record, decider(ctx, "reinstate", staff, ["approver"]), reason));
        return answer({ key: keyText(record.key), state: result.state, record: recordHash(result) }, `reinstated ${keyText(record.key)}: ${result.state}`);
      }),
    );

  trust
    .command("demote")
    .argument("<key>", "app/capability@x.y.z, with +p<n> for a patch")
    .description("take trust from an approved key (operator or approver); the reason comes from standard input")
    .action(
      act(ctxOf, async (ctx, args) => {
        const who = requireOperatorOrApprover(ctx);
        const record = await currentRecord(scoreDeps(ctx), await keyFromText(ctx, args[0]));
        const reason = await reasonText(ctx);
        const result = done("demote", await demoteKey(scoreDeps(ctx), record, decider(ctx, "demote", who.staff, [who.role]), reason));
        return answer({ key: keyText(record.key), state: result.state, record: recordHash(result) }, `demoted ${keyText(record.key)}: ${result.state}`);
      }),
    );

  trust
    .command("retire")
    .argument("<key>", "app/capability@x.y.z, with +p<n> for a patch")
    .description("retire a key (operator or approver); the reason comes from standard input")
    .action(
      act(ctxOf, async (ctx, args) => {
        const who = requireOperatorOrApprover(ctx);
        const record = await currentRecord(scoreDeps(ctx), await keyFromText(ctx, args[0]));
        const reason = await reasonText(ctx);
        const result = done("retire", await retireKey(scoreDeps(ctx), record, decider(ctx, "retire", who.staff, [who.role]), reason));
        return answer({ key: keyText(record.key), state: result.state, record: recordHash(result) }, `retired ${keyText(record.key)}: ${result.state}`);
      }),
    );
}
