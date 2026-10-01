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
  excludeRuns,
  rejectKey,
  reinstateKey,
  restoreAfterExclusion,
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
import { answer, progress, type Answer } from "../output.js";
import { act, readVersion } from "../program.js";
import { loadFrozenSetFor } from "./pack.js";
import { currentRecord, exitFor, keyFromText, scoreDeps, tenantRecords, whoIs } from "./trust-shared.js";

/** Standard input as text (the alert commands read their notes the same way): piped, or one question on a terminal. A terminal with no prompt gives "". */
export async function stdinText(ctx: Ctx, prompt: string | null): Promise<string> {
  if (ctx.io.stdin.isTTY === true) return prompt === null ? "" : (await ctx.io.stdin.question(prompt)).trim();
  return (await ctx.io.stdin.readAll()).trim();
}

/** A required reason, from standard input. */
export async function reasonText(ctx: Ctx): Promise<string> {
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
export function decider(ctx: Ctx, command: string, staff: string, roles: Decider["roles"]): Decider {
  return {
    at: ctx.wiring.clock.now(),
    staff,
    roles,
    who: { owner: ctx.wiring.ids.batchId(), command: `trust ${command}`, staff: ctx.staff },
  };
}

/** Unwraps a decision, or ends the command with the failure's exit code. */
export function done<T>(command: string, r: Outcome<T, DecisionFailure>): T {
  if (!r.ok) throw new CliExit(exitFor(r.failure), `trust ${command}: ${r.detail ?? r.failure}`);
  return r.value;
}

/** Taking trust away needs an operator or an approver (section 8 §10.1). Returns the staff ID and the role that qualified. */
export function requireOperatorOrApprover(ctx: Ctx): { staff: string; role: "operator" | "approver" } {
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

/** The approve path both the flags and the guided walk end in: `approveKey` (which runs the state machine), then the answer. */
async function approveWith(
  ctx: Ctx,
  staff: string,
  facts: ReviewFacts,
  batch: string,
  acks: readonly string[],
  note: string,
): Promise<Answer> {
  const result = done(
    "approve",
    await approveKey(scoreDeps(ctx), facts.record, decider(ctx, "approve", staff, facts.who?.roles ?? []), {
      batch,
      acknowledged: [...new Set(acks)],
      note: note === "" ? null : note,
      // Why: section 8 §9.6. Approval installs the timeouts the batch ran with (tested), and the
      // batch's own proposals become the next candidates.
      timeouts: { ...(facts.report?.timeouts?.ran_with ?? {}) },
      candidate: { ...(facts.report?.timeouts?.proposed ?? {}) },
      prior: priorApproved(await tenantRecords(ctx, scoreDeps(ctx)), facts.key),
    }),
  );
  const text = [
    `approved ${keyText(facts.key)} on ${batch} by ${staff}`,
    ...result.retired.map((k) => `retired ${k}`),
    `RECORD ${recordHash(result.record)}`,
  ];
  return answer({ key: keyText(facts.key), state: result.record.state, retired: result.retired, record: recordHash(result.record) }, text.join("\n"));
}

/**
 * The guided walk for `trust approve` (section 9 §9.4, end). It shows the review screen, then asks
 * for each fragile step's name (the `--ack`), the note, and the first 6 characters of the record
 * hash. It then gathers the facts again and runs the same refusals as the flags: the hash the
 * approver confirmed must still be the record's (`--expect-record`), nothing may block, every
 * fragile step must be acknowledged. A typed answer never skips a rule; it only supplies the flags.
 */
async function guidedApprove(ctx: Ctx, staff: string, keyArg: string | undefined, batchArg: string | undefined): Promise<Answer> {
  const key = await keyFromText(ctx, keyArg);
  const seen = await gather(ctx, key, batchArg);
  if (seen.batchId === null) throw new CliExit(EXIT.usage, "trust approve: the key has no full batch yet; run intyy certify first");
  const batch = seen.batchId;
  const shownHash = recordHash(seen.record);
  const fragile = fragileSteps(seen.record);
  // Why standard error: standard output stays the one answer, also with `--json` (section 9 §7.4).
  progress(ctx.io, `${renderReview(buildReview(seen), false)}\n`);

  // Why before any question: a block cannot be fixed by an answer. Passing every fragile step as
  // acknowledged leaves only the blocks (and a changed record, which cannot be here yet).
  const blocked = refusals(seen, "approve", shownHash, fragile);
  if (blocked.length > 0) {
    throw new CliExit(EXIT.refused, `trust approve refused:\n${blocked.map((r) => `  ${r.code}: ${r.detail}`).join("\n")}`);
  }

  const acks: string[] = [];
  for (const step of fragile) {
    const said = (await ctx.io.stdin.question(`Fragile step ${step}. Type its name to say you read it: `)).trim();
    if (said === step) acks.push(step);
  }
  const note = (await ctx.io.stdin.question("Note (blank for none): ")).trim();
  const typed = (await ctx.io.stdin.question("Record hash, first 6 characters: ")).trim().toLowerCase().replace(/^sha256:/, "");
  const plain = shownHash.replace(/^sha256:/, "");
  if (typed.length < 6 || !plain.startsWith(typed)) {
    throw new CliExit(EXIT.refused, "trust approve refused:\n  hash_mismatch: the characters you typed are not the start of the record hash on the screen");
  }

  // Why gather again: time passed while the approver typed. The hash they confirmed is the one
  // the screen showed, so a demotion or a new batch since then refuses as `record_changed`.
  const fresh = await gather(ctx, key, batch);
  refuseIf("approve", fresh, "approve", shownHash, acks);
  return approveWith(ctx, staff, fresh, batch, acks, note);
}

/**
 * `trust restore --after-exclusion` (section 8 §10.8, section 9 §9.4). The quoted hash must be the
 * record's now. The batch rules do not apply: the key needs no new batch, and `restoreAfterExclusion`
 * checks that a live rule degraded it, that a run which did so is excluded, and that no rule still fires.
 */
async function restoreAfterExclusionWith(ctx: Ctx, staff: string, keyArg: string | undefined, quoted: string): Promise<Answer> {
  const deps = scoreDeps(ctx);
  const record = await currentRecord(deps, await keyFromText(ctx, keyArg));
  const now = recordHash(record);
  if (quoted !== now) {
    throw new CliExit(
      EXIT.refused,
      `trust restore refused:\n  record_changed: the record is ${now} now (state ${record.state}), not ${quoted}; run intyy trust show again`,
    );
  }
  const note = await stdinText(ctx, null);
  const result = done(
    "restore",
    await restoreAfterExclusion(deps, record, decider(ctx, "restore", staff, whoIs(ctx)?.roles ?? []), { note: note === "" ? null : note }),
  );
  return answer(
    { key: keyText(record.key), state: result.state, record: recordHash(result) },
    `restored ${keyText(record.key)} after excluded runs\nRECORD ${recordHash(result)}`,
  );
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
    .description("approve a key (approver, not the sealer); piped standard input is the note; on a terminal with no --expect-record, a guided walk asks")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const staff = requireRole(ctx, ctx.tenant, "approver");
        // Why: section 9 §9.4, "on a terminal, the guided walk asks for each --ack, the note, and the
        // first 6 characters of the hash". A terminal with `--expect-record` already knows what it quotes.
        if (ctx.io.stdin.isTTY === true && opts.expectRecord === undefined) {
          return guidedApprove(ctx, staff, args[0], typeof opts.batch === "string" ? opts.batch : undefined);
        }
        const batch = needed(opts, "batch", "--batch");
        const quoted = needed(opts, "expectRecord", "--expect-record");
        const acks = Array.isArray(opts.ack) ? opts.ack.filter((a): a is string => typeof a === "string") : [];
        const facts = await gather(ctx, await keyFromText(ctx, args[0]), batch);
        const unknown = acks.filter((a) => !fragileSteps(facts.record).includes(a));
        if (unknown.length > 0) throw new CliExit(EXIT.usage, `--ack ${unknown.join(", ")}: not a fragile step of this key`);
        refuseIf("approve", facts, "approve", quoted, acks);
        return approveWith(ctx, staff, facts, batch, acks, await stdinText(ctx, null));
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
    .option("--after-exclusion", "restore after excluded runs, without a new batch (the key must have degraded on a live rule)")
    .option("--expect-record <hash>", "the record hash the review screen ended with")
    .description("restore a degraded key (approver); a piped standard input becomes the note")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const staff = requireRole(ctx, ctx.tenant, "approver");
        if (opts.afterExclusion === true) {
          if (opts.batch !== undefined) throw new CliExit(EXIT.usage, "give --batch or --after-exclusion, not both");
          return restoreAfterExclusionWith(ctx, staff, args[0], needed(opts, "expectRecord", "--expect-record"));
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
    .command("exclude")
    .argument("<key>", "app/capability@x.y.z, with +p<n> for a patch")
    .argument("[run_ids...]", "live runs to remove from the window")
    .description("remove live runs from the key's window (approver); the reason comes from standard input")
    .action(
      act(ctxOf, async (ctx, args) => {
        const staff = requireRole(ctx, ctx.tenant, "approver");
        const named = args.slice(1);
        if (named.length === 0) throw new CliExit(EXIT.usage, "name the runs to exclude: trust exclude <key> <run_id>…");
        const record = await currentRecord(scoreDeps(ctx), await keyFromText(ctx, args[0]));
        const reason = await reasonText(ctx);
        const result = done("exclude", await excludeRuns(scoreDeps(ctx), record, decider(ctx, "exclude", staff, ["approver"]), { runs: named, reason }));
        return answer(
          { key: keyText(record.key), excluded: [...new Set(named)], record: recordHash(result) },
          `excluded ${String(new Set(named).size)} run(s) from ${keyText(record.key)}\nRECORD ${recordHash(result)}`,
        );
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
