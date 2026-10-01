// `intyy evidence publish | verify`: copy chosen runs and batches into the repo's `evidence/`, and
// re-check what is there. Follows design section 9 §6.6 and §7 (the role table: publish needs the
// reviewer role, verify none) and the updates file §12. The checks live in `core/evidence/`.
import type { Command } from "commander";
import { BatchId, RunId } from "../../core/model/ids.js";
import { canaryMarkers } from "../../core/evidence/markers.js";
import {
  publishEvidence,
  verifyEvidence,
  type PublishFailure,
  type PublishTarget,
} from "../../core/evidence/publish.js";
import type { Markers } from "../../core/evidence/markers.js";
import { keyPath } from "../../core/trust/keys.js";
import { requireRole, type Ctx } from "../context.js";
import { CliExit, EXIT, type ExitCode } from "../exit-codes.js";
import { answer, progress } from "../output.js";
import { act, type Register } from "../program.js";
import { load } from "./documents.js";
import { settingsTarget } from "./settings.js";
import { keyFromText } from "./trust-shared.js";

/** An exact trust key, like `kvfcu/open_share_subaccount@1.0.0`, with `+p3` for a patch. Its snapshot publishes (section 9 §6.6). */
const KEY = /^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_]*@\d+\.\d+\.\d+(\+p[1-9]\d*)?$/;

/** The exit code for each refusal: a broken file is `invalid`, a missing target is a usage error. */
function exitFor(failure: PublishFailure): ExitCode {
  if (failure === "not_found") return EXIT.usage;
  if (failure === "run_invalid" || failure === "manifest_invalid") return EXIT.invalid;
  return EXIT.refused;
}

/** The canary markers from `intyy.json` and the tenant's approved settings. Settings are required:
 * without them the secret canary could not run, and "clean" would mean less than it says. */
async function markersOf(ctx: Ctx): Promise<Markers> {
  const settings = await load(settingsTarget(ctx), ["approved"]);
  if (settings === undefined) {
    throw new CliExit(EXIT.invalid, `settings ${ctx.tenant} have no approved revision; the canary scan needs their secret bindings`);
  }
  const markers = await canaryMarkers(ctx.config.canary_members, settings.doc, ctx.wiring.secrets);
  for (const k of markers.missing) progress(ctx.io, `warning: ${k} has no value; it is not scanned`);
  return markers;
}

/** Registers the evidence commands. */
export const registerEvidence: Register = (program: Command, ctxOf) => {
  const evidence = program.command("evidence").description("publish runs and records into evidence/, and verify them");

  evidence
    .command("publish")
    .argument("<targets...>", "run IDs, batch IDs, or trust keys")
    .option("--with-runs <which>", "all: a batch publishes every run, not only the ones whose verdict is not pass")
    .description("copy runs, batches, and the artifacts they used into evidence/, after the safety checks")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const by = requireRole(ctx, ctx.tenant, "reviewer");
        if (opts.withRuns !== undefined && opts.withRuns !== "all") {
          throw new CliExit(EXIT.usage, "--with-runs takes one value: all");
        }
        const targets: PublishTarget[] = [];
        for (const t of args) {
          if (RunId.safeParse(t).success) targets.push({ kind: "run", id: t });
          else if (BatchId.safeParse(t).success) targets.push({ kind: "batch", id: t });
          else if (KEY.test(t)) targets.push({ kind: "key", id: keyPath(await keyFromText(ctx, t)) });
          else throw new CliExit(EXIT.usage, `${t}: not a run ID, a batch ID, or a key`);
        }
        if (targets.length === 0) return answer({ published: false }, "nothing to publish");
        const markers = await markersOf(ctx);
        const got = await publishEvidence(
          {
            tenant: ctx.tenant,
            targets,
            ...(opts.withRuns === "all" ? { withRuns: "all" as const } : {}),
            by,
            markers: markers.values,
          },
          { ...ctx.wiring.publish, clock: ctx.wiring.clock },
        );
        if (!got.ok) {
          throw new CliExit(exitFor(got.failure), `publish refused (${got.failure}): ${got.detail ?? ""}`);
        }
        for (const w of got.value.warnings) progress(ctx.io, `warning: ${w}`);
        const r = got.value;
        return answer(
          { published: true, ...r },
          [
            `published ${String(r.runs.length)} runs, ${String(r.batches.length)} batches, ${String(r.artifacts.length)} artifacts`,
            `${String(r.files)} files, ${String(r.bytes)} bytes; evidence/ now holds ${String(r.totalBytes)} bytes`,
          ].join("\n"),
        );
      }),
    );

  evidence
    .command("verify")
    .description("re-check evidence/: hashes, links, forbidden files, and canaries")
    .action(
      act(ctxOf, async (ctx) => {
        const markers = await markersOf(ctx);
        const got = await verifyEvidence({ markers: markers.values }, { dest: ctx.wiring.publish.dest });
        if (!got.ok) throw new CliExit(exitFor(got.failure === "no_manifest" ? "not_found" : "manifest_invalid"), `verify: ${got.detail ?? got.failure}`);
        const { items, files, problems } = got.value;
        if (problems.length === 0) {
          return answer({ clean: true, items, files, problems }, `clean: ${String(items)} items, ${String(files)} files`);
        }
        return answer(
          { clean: false, items, files, problems },
          [`${String(problems.length)} problems:`, ...problems.map((p) => `  ${p}`)].join("\n"),
          EXIT.failed,
        );
      }),
    );
};
