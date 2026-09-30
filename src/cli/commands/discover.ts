// `intyy discover <app/name>`: one supervised discovery run in a visible browser. It prints the
// run ID; M04 adds the candidate. Follows design section 9 §8.1 (discover), §12.2 (the instance
// lock), §7.5 (exit codes), section 6 §4 (discovery in one view), and section 4 §10.6.
import type { Command } from "commander";
import { runDiscovery } from "../../core/orchestrator/discovery.js";
import { requireRole, takeLock, type Ctx } from "../context.js";
import { CliExit, EXIT, exitForStatus } from "../exit-codes.js";
import { answer, progress } from "../output.js";
import { act, readVersion, type Register } from "../program.js";
import { attachNegativeRunOrExit, recordPositiveRunOrExit } from "./candidate.js";
import { load, orExit } from "./documents.js";
import { effectivePolicy } from "./policy.js";
import { settingsTarget } from "./settings.js";
import { parseSpecName, readSpec } from "./spec.js";

/** The instance lock key for an origin. Example: `http_127.0.0.1_8080` (section 9 §12.2). */
export function instanceKey(origin: string): string {
  const u = new URL(origin);
  return `${u.protocol.replace(":", "")}_${u.hostname}${u.port === "" ? "" : `_${u.port}`}`;
}

/** The model key, by the variable `intyy.json` names. Its value is never printed. */
function modelKey(ctx: Ctx): string {
  const name = ctx.config.model_keys.claude;
  const key = ctx.io.env[name];
  if (key === undefined || key === "")
    throw new CliExit(EXIT.usage, `set ${name} to run discovery`);
  return key;
}

/** Registers `discover`. */
export const registerDiscover: Register = (program: Command, ctxOf) => {
  program
    .command("discover")
    .argument("<app/name>", "the run spec, like kvfcu/sign_in")
    .option(
      "--candidate <candidate_id>",
      "attach a successful negative run to this candidate instead of starting a new one",
    )
    .description("run one supervised discovery in a visible browser (operator); prints the run ID")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const attachTo = typeof opts.candidate === "string" ? opts.candidate : undefined;
        const name = parseSpecName(args[0]);
        const staff = requireRole(ctx, ctx.tenant, "operator");
        const spec = readSpec(ctx, name);
        // Why fail fast, before the browser opens: section 6 §14.8, a negative run only ever
        // attaches to an existing candidate; a positive run always starts its own.
        if (spec.kind === "negative_discovery" && attachTo === undefined) {
          throw new CliExit(
            EXIT.usage,
            `${name.app}/${name.name} is a negative_discovery spec; pass --candidate <id> to attach it`,
          );
        }
        if (spec.kind === "discovery" && attachTo !== undefined) {
          throw new CliExit(
            EXIT.usage,
            `${name.app}/${name.name} is a discovery spec; --candidate only attaches a negative_discovery run`,
          );
        }
        const t = settingsTarget(ctx);
        const settings = await load(t, ["approved"]);
        if (settings === undefined)
          throw new CliExit(EXIT.invalid, `settings ${ctx.tenant} have no approved revision`);
        const sealed = orExit(await t.store.get(t.id, settings.rev), `settings ${ctx.tenant}`);
        const app = settings.doc.apps[spec.app];
        if (app === undefined) throw new CliExit(EXIT.invalid, `settings name no app ${spec.app}`);
        const apiKey = modelKey(ctx);
        const policy = await effectivePolicy(ctx, spec.app);
        const runId = ctx.wiring.ids.runId();
        // Why: CONTRACT §2 and section 9 §12.2, one run at a time on the instance.
        const hold = await takeLock(ctx, "instance", instanceKey(app.origin), {
          owner: runId,
          command: "discover",
          staff,
          waitMs: 0,
        });
        // Why a run lock too: the crash sweep tells a live discovery from a crashed one by
        // whether this exact lock is still held (section 7 §17, docs/decisions.md, M05).
        const runHold = await takeLock(ctx, "run", runId, {
          owner: runId,
          command: "discover",
          staff,
          waitMs: 0,
        });
        const stop = new AbortController();
        const onInt = (): void => {
          progress(ctx.io, "Stopping: the run ends as ended_by_operator.");
          stop.abort();
        };
        process.once("SIGINT", onInt);
        progress(
          ctx.io,
          `run ${runId}: discovering ${spec.app}/${spec.capability}. Watch the browser.`,
        );
        progress(ctx.io, "Answer approvals in another terminal: intyy operator list");
        const marker = ctx.wiring.discovery.marker();
        try {
          const r = await runDiscovery(
            {
              runId,
              spec,
              tenant: ctx.tenant,
              staff,
              policy,
              settings: { doc: settings.doc, rev: settings.rev, hash: sealed.hash },
              engineVersion: readVersion(),
              canaries: ctx.config.canary_members,
              visible: true,
            },
            {
              evidence: ctx.wiring.evidence,
              clock: ctx.wiring.clock,
              ids: ctx.wiring.ids,
              secrets: ctx.wiring.secrets,
              surface: ctx.wiring.discovery.surface(),
              marker,
              planner: ctx.wiring.discovery.planner(apiKey),
              operator: ctx.wiring.discovery.operator,
              signal: stop.signal,
            },
          );
          for (const p of r.problems) progress(ctx.io, `  ${p}`);
          const code = r.code === null ? "" : `, ${r.code}`;
          const base = { run_id: r.runId, status: r.status, code: r.code, problems: r.problems };
          // Why these exact pairs: section 6 §14.8. A positive spec's own goal is `success`; a
          // negative spec's is `business_outcome`, the reported outcome. Anything else (a
          // negative run that unexpectedly succeeds, or either kind ending failed or rejected)
          // leaves no candidate: the run did not do what its spec set out to prove.
          if (spec.kind === "discovery" && r.status === "success") {
            const { id, output } = await recordPositiveRunOrExit(ctx, r.runId);
            return answer(
              { ...base, candidate: id, issues: output.issues.length },
              `${r.runId}\n${r.status}${code}\ncandidate ${id}`,
              exitForStatus(r.status),
            );
          }
          if (spec.kind === "negative_discovery" && r.status === "business_outcome" && attachTo !== undefined) {
            const output = await attachNegativeRunOrExit(ctx, attachTo, r.runId);
            return answer(
              { ...base, candidate: attachTo, issues: output.issues.length },
              `${r.runId}\n${r.status}${code}\ncandidate ${attachTo} updated.`,
              exitForStatus(r.status),
            );
          }
          return answer(base, `${r.runId}\n${r.status}${code}`, exitForStatus(r.status));
        } finally {
          process.removeListener("SIGINT", onInt);
          await marker.close();
          await ctx.wiring.locks.release(runHold);
          await ctx.wiring.locks.release(hold);
        }
      }),
    );
};
