// `intyy trust autonomy <key> [grant|revoke]`: read, grant, or revoke a key's reconciliation autonomy.
// Follows design section 9 §9.5 and section 8 §14.2. The rules are in core/trust/autonomy.ts and
// decisions.ts; this file gathers facts and maps refusals to exit codes. A reason comes from
// standard input, never a flag (docs/decisions.md, M04).
import type { Command } from "commander";
import { readArtifact } from "../../core/catalog/artifacts.js";
import { describeAutonomy, stateFor } from "../../core/trust/autonomy.js";
import { grantAutonomy, revokeAutonomy } from "../../core/trust/decisions.js";
import { capabilityParts, keyText } from "../../core/trust/keys.js";
import { recordHash } from "../../core/trust/rebuild.js";
import { checkKeyOf } from "../../core/replay/run-autonomy.js";
import type { ScoreRecord } from "../../core/model/score.js";
import { requireRole, type Ctx } from "../context.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer } from "../output.js";
import { act } from "../program.js";
import { decider, done, reasonText, requireOperatorOrApprover } from "./trust-approval.js";
import { currentRecord, keyFromText, scoreDeps, whoIs } from "./trust-shared.js";

/**
 * The scope a run would use now, as far as the CLI can know it. The check key comes from the sealed
 * artifact's link. The jev version is the record's own: no jev adapter is wired here, so only a changed
 * check key reads as a scope change (section 8 §14.2).
 */
async function currentScope(ctx: Ctx, record: ScoreRecord): Promise<{ check: string | null; check_patch: number | null; jev: string | null }> {
  const { name, version } = capabilityParts(record.key.capability);
  const [app = "", capability = ""] = name.split("/");
  const artifact = await readArtifact(ctx.wiring.candidates, app, capability, version);
  const check = await checkKeyOf(ctx.wiring.candidates, artifact.ok ? artifact.value : null, record.key.app_version);
  return { check, check_patch: null, jev: record.autonomy?.jev ?? null };
}

/** Registers `trust autonomy` under `trust`. */
export function registerAutonomy(trust: Command, ctxOf: () => Ctx): void {
  trust
    .command("autonomy")
    .argument("<key>", "app/capability@x.y.z")
    .argument("[action]", "grant or revoke; omit it to read the record")
    .option("--expect-record <hash>", "grant: the record hash `trust show` ended with")
    .description("reconciliation autonomy: read it; grant it when ready (approver); revoke it (operator or approver); the reason is piped on standard input")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        // Why both orders: section 9 §9.5 writes `trust autonomy grant <key>`; the build brief writes `trust autonomy <key> grant`.
        const [first, second] = [args[0], args[1]];
        const verb = (t: string | undefined): t is "grant" | "revoke" => t === "grant" || t === "revoke";
        const action = verb(first) ? first : verb(second) ? second : undefined;
        const keyArg = verb(first) ? second : first;
        if (action === undefined && second !== undefined) throw new CliExit(EXIT.usage, "the action is grant or revoke");
        const deps = scoreDeps(ctx);
        const record = await currentRecord(deps, await keyFromText(ctx, keyArg));
        const key = keyText(record.key);
        const scope = await currentScope(ctx, record);
        if (action === undefined) {
          return answer(
            { key, state: stateFor(record.autonomy, scope), autonomy: record.autonomy, record: recordHash(record) },
            `${key}\nautonomy ${describeAutonomy(record.autonomy, scope)}\nRECORD ${recordHash(record)}`,
          );
        }
        if (action === "grant") {
          const staff = requireRole(ctx, ctx.tenant, "approver");
          const quoted = opts.expectRecord;
          if (typeof quoted !== "string" || quoted === "") throw new CliExit(EXIT.usage, "--expect-record is required");
          const now = recordHash(record);
          if (quoted !== now) {
            throw new CliExit(EXIT.refused, `trust autonomy grant refused:\n  record_changed: the record is ${now} now, not ${quoted}; run intyy trust autonomy ${key} again`);
          }
          const reason = await reasonText(ctx);
          const granted = done("autonomy grant", await grantAutonomy(deps, record, decider(ctx, "autonomy", staff, whoIs(ctx)?.roles ?? []), { scope, reason }));
          return answer({ key, state: "granted", record: recordHash(granted) }, `granted reconciliation autonomy on ${key} by ${staff}\nRECORD ${recordHash(granted)}`);
        }
        const { staff } = requireOperatorOrApprover(ctx);
        const reason = await reasonText(ctx);
        const revoked = done(
          "autonomy revoke",
          await revokeAutonomy(deps, record.key, {
            by: staff,
            reason,
            runs: [],
            at: ctx.wiring.clock.now(),
            who: { owner: ctx.wiring.ids.batchId(), command: "trust autonomy", staff: ctx.staff },
            roles: whoIs(ctx)?.roles ?? [],
          }),
        );
        return answer({ key, state: "revoked", record: recordHash(revoked) }, `revoked reconciliation autonomy on ${key} by ${staff}; the evidence is zero\nRECORD ${recordHash(revoked)}`);
      }),
    );
}
