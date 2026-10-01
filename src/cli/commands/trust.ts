// `intyy trust rebuild [<key> | --all]`: rebuild score records from their history lines.
// Follows design section 9 §9.8; section 8 §5.2. The approval family is in trust-approval.ts (section 9 §9.4).
import type { Command } from "commander";
import { recordHash } from "../../core/trust/rebuild.js";
import { liveFromEvidence } from "../../core/trust/live-evidence.js";
import { keyPath } from "../../core/trust/keys.js";
import { listKeys, rebuildKey, repairLive, type Rebuilt } from "../../core/trust/scores.js";
import { requireRole } from "../context.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer } from "../output.js";
import { act, type Register } from "../program.js";
import { registerApproval } from "./trust-approval.js";
import { exitFor, keyFromText, scoreDeps } from "./trust-shared.js";

/** One line per rebuilt key. */
function describe(r: Rebuilt): string {
  const where = `${r.key.capability} (app ${r.key.app_version}, ${r.key.patch_revision === null ? "no patch" : `patch ${String(r.key.patch_revision)}`})`;
  if (!r.written) return `${where}: no score files; stays draft, nothing written`;
  const diff =
    r.before === null
      ? "record written (none before)"
      : r.changed.length === 0
        ? "unchanged"
        : `changed: ${r.changed.join(", ")}`;
  return `${where}: ${r.after.state}, ${diff}, ${recordHash(r.after)}`;
}

/** Registers the trust commands built so far. */
export const registerTrust: Register = (program: Command, ctxOf) => {
  const trust = program.command("trust").description("trust state per key: scores and approval");
  registerApproval(trust, ctxOf);

  trust
    .command("rebuild")
    .argument("[key]", "app/capability@x.y.z, with +p<n> for a patch")
    .option("--all", "every key of this tenant that has score files")
    .option("--from-evidence", "first recreate live.jsonl from the run files in evidence")
    .description("rebuild record.json from history lines, under the score lock (operator)")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const all = opts.all === true;
        if (all === (args[0] !== undefined)) {
          throw new CliExit(EXIT.usage, "name one key, or pass --all");
        }
        requireRole(ctx, ctx.tenant, "operator");
        const deps = scoreDeps(ctx);
        const who = { owner: ctx.wiring.ids.batchId(), command: "trust rebuild", staff: ctx.staff };
        const found = all ? await listKeys(ctx.wiring.scores, ctx.tenant) : { keys: [await keyFromText(ctx, args[0])], skipped: [] };
        // Why first: section 9 §9.8, `--from-evidence` recreates `live.jsonl` before the record is rebuilt from both logs.
        const repaired: string[] = [];
        if (opts.fromEvidence === true) {
          const evidence = await liveFromEvidence(ctx.wiring.evidence, ctx.tenant);
          const known = new Set(found.keys.map(keyPath));
          // Why: `--all` also covers a key whose runs left lines in evidence but whose score files are gone.
          if (all) for (const [path, e] of evidence.byKey) if (!known.has(path)) found.keys.push(e.key);
          for (const key of found.keys) {
            const r = await repairLive(deps, key, evidence.byKey.get(keyPath(key))?.lines ?? [], who);
            if (!r.ok) throw new CliExit(exitFor(r.failure), `trust rebuild ${key.capability}: live lines: ${r.detail ?? r.failure}`);
            repaired.push(`${key.capability}: live.jsonl holds ${String(r.value.total)} line(s), ${String(r.value.added)} new from evidence`);
          }
          for (const id of evidence.unreadable) repaired.push(`skipped run ${id}: run.json is unreadable`);
        }
        const done: Rebuilt[] = [];
        for (const key of found.keys) {
          const r = await rebuildKey(deps, key, who);
          if (!r.ok) throw new CliExit(exitFor(r.failure), `trust rebuild ${key.capability}: ${r.detail ?? r.failure}`);
          done.push(r.value);
        }
        const lines = [
          ...repaired,
          ...done.map(describe),
          ...found.skipped.map((p) => `skipped ${p}: not a key folder`),
        ];
        return answer(
          {
            rebuilt: done.map((r) => ({
              key: r.key,
              state: r.after.state,
              written: r.written,
              changed: r.changed,
              record: recordHash(r.after),
            })),
            skipped: found.skipped,
            live: repaired,
          },
          lines.length === 0 ? "No score files to rebuild." : lines.join("\n"),
        );
      }),
    );
};
