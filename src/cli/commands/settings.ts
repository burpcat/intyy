// `intyy settings edit | check | seal | approve`, and `settings check --secrets`.
// Follows design section 9 §8.6, section 4 §5 (settings file) and §8.3, §8.4 (bindings, start check).
import type { Command } from "commander";
import { settingsKind } from "../../core/model/kinds.js";
import { settingsBindings, type Settings } from "../../core/model/settings.js";
import type { Ctx } from "../context.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer, type Answer } from "../output.js";
import { act, type Register } from "../program.js";
import {
  approveDoc,
  editDoc,
  load,
  revOption,
  sealDoc,
  type DocTarget,
  type Loaded,
} from "./documents.js";

/** The settings file of the command's tenant. Roles are per tenant. */
export function settingsTarget(ctx: Ctx): DocTarget<Settings> {
  return {
    store: ctx.wiring.settings,
    kind: settingsKind,
    id: ctx.tenant,
    label: `settings ${ctx.tenant}`,
    scope: ctx.tenant,
  };
}

/** Settings have no rules to merge; the schema holds every loader check (section 4 §5.4). */
const noMoreChecks = (): Promise<string[]> => Promise.resolve([]);

/** A starting file for a new revision. */
function nextRevision(ctx: Ctx, base: Loaded<Settings> | undefined): unknown {
  if (!base) return { schema: "intyy.settings/1.0", tenant: ctx.tenant, revision: 1, apps: {} };
  const next: Record<string, unknown> = { ...base.doc, revision: base.doc.revision + 1 };
  delete next.approved;
  return next;
}

/**
 * Lists each bound secret with "set" or "missing". It resolves every binding but never prints a
 * value: only names and states (section 4 §8.4, M01 spec). Any missing name exits 1.
 */
async function secretsReport(
  ctx: Ctx,
  t: DocTarget<Settings>,
  got: Loaded<Settings>,
): Promise<Answer> {
  const rows: { name: string; key: string; status: "set" | "missing" }[] = [];
  for (const b of settingsBindings(got.doc)) {
    const r = await ctx.wiring.secrets.resolve({ source: "env", key: b.key });
    rows.push({ name: b.label, key: b.key, status: r.ok ? "set" : "missing" });
  }
  const missing = rows.filter((r) => r.status === "missing").length;
  const width = Math.max(0, ...rows.map((r) => r.name.length));
  const lines = [
    `${t.label} ${got.rev} (${got.state}): ${String(rows.length)} bound secrets`,
    ...rows.map((r) => `  ${r.name.padEnd(width)}  ${r.key}  ${r.status}`),
    ...(missing > 0 ? [`${String(missing)} missing. Set them in .env or the shell.`] : []),
  ];
  return answer(
    { document: t.label, rev: got.rev, state: got.state, secrets: rows },
    lines.join("\n"),
    missing > 0 ? EXIT.usage : undefined,
  );
}

/** Registers the settings commands. */
export const registerSettings: Register = (program: Command, ctxOf) => {
  const settings = program
    .command("settings")
    .description("the tenant's bank settings: where apps live");

  settings
    .command("edit")
    .description("open $EDITOR on the tenant's settings candidate, then validate it")
    .action(
      act(ctxOf, (ctx) =>
        editDoc(ctx, settingsTarget(ctx), (base) => nextRevision(ctx, base), noMoreChecks),
      ),
    );

  settings
    .command("check")
    .option("--secrets", "also list each bound secret as set or missing; never values")
    .description("validate the candidate, or else the newest sealed revision; writes nothing")
    .action(
      act(ctxOf, async (ctx, _args, opts) => {
        const t = settingsTarget(ctx);
        const got = await load(t, ["candidate", "approved", "sealed"]);
        if (!got) throw new CliExit(EXIT.usage, `${t.label} has no candidate or sealed revision`);
        if (opts.secrets === true) return secretsReport(ctx, t, got);
        return answer(
          { document: t.label, rev: got.rev, state: got.state, valid: true },
          `${t.label} ${got.rev} (${got.state}) is valid.`,
        );
      }),
    );

  settings
    .command("seal")
    .description("freeze the settings candidate as a sealed revision (reviewer)")
    .action(act(ctxOf, (ctx) => sealDoc(ctx, settingsTarget(ctx), noMoreChecks)));

  settings
    .command("approve")
    .requiredOption("--rev <n>", "the sealed revision to approve")
    .description("stamp a sealed revision (approver, never its sealer)")
    .action(
      act(ctxOf, (ctx, _args, opts) => approveDoc(ctx, settingsTarget(ctx), revOption(opts))),
    );
};
