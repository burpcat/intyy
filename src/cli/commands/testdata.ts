// `intyy testdata edit | check | seal | approve <app>`: the tenant's certify test data.
// Follows design section 9 §8.7 and section 8 §6.2 (test data set).
import type { Command } from "commander";
import { AppId } from "../../core/model/common.js";
import { testdataKind } from "../../core/model/kinds.js";
import { checkNoCanary, checkNotProduction, type Testdata } from "../../core/model/testdata.js";
import type { Ctx } from "../context.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer } from "../output.js";
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
import { settingsTarget } from "./settings.js";

/** Parses `<app>`. */
function appArg(text: string | undefined): string {
  const parsed = AppId.safeParse(text ?? "");
  if (!parsed.success) throw new CliExit(EXIT.usage, "app: write a lower-case app ID, like kvfcu");
  return parsed.data;
}

/** The current tenant's test data for one app. Roles are per tenant (section 9 §8.7). */
function target(ctx: Ctx, app: string): DocTarget<Testdata> {
  const id = `${ctx.tenant}/${app}`;
  return { store: ctx.wiring.testdata, kind: testdataKind, id, label: `testdata ${id}`, scope: ctx.tenant };
}

/**
 * Section 9 §8.7: `testdata check` also refuses an app whose settings say `environment:
 * production`, and CLAUDE.md bans the canary from test data.
 */
async function validate(ctx: Ctx, doc: Testdata): Promise<string[]> {
  const settings = await load(settingsTarget(ctx), ["approved", "sealed"]);
  const environment = settings?.doc.apps[doc.app]?.environment;
  return [...checkNoCanary(doc, ctx.config.canary_members), ...checkNotProduction(environment)];
}

/** A fresh candidate: the previous sealed revision counted up, or an empty skeleton. */
function nextRevision(ctx: Ctx, app: string, base: Loaded<Testdata> | undefined): unknown {
  if (base) {
    const next: Record<string, unknown> = { ...base.doc, revision: base.doc.revision + 1 };
    delete next.approved;
    return next;
  }
  return {
    schema: "intyy.testdata/1.0",
    tenant: ctx.tenant,
    app,
    revision: 1,
    pools: {},
    instance: { variant: ctx.tenant, strip_semantics: false, drop_labels: 0, label_seed: "0" },
    business_date: "2026-01-15",
  };
}

/** Registers the testdata commands. */
export const registerTestdata: Register = (program: Command, ctxOf) => {
  const testdata = program
    .command("testdata")
    .description("certify test data: named pools of fake values, per tenant and app");

  testdata
    .command("edit")
    .argument("<app>", "the app ID")
    .description("open $EDITOR on the app's test data candidate, then validate it")
    .action(
      act(ctxOf, (ctx, args) => {
        const app = appArg(args[0]);
        return editDoc(ctx, target(ctx, app), (base) => nextRevision(ctx, app, base), (doc) => validate(ctx, doc));
      }),
    );

  testdata
    .command("check")
    .argument("<app>", "the app ID")
    .description("validate the candidate, or else the newest sealed revision; writes nothing")
    .action(
      act(ctxOf, async (ctx, args) => {
        const t = target(ctx, appArg(args[0]));
        const got = await load(t, ["candidate", "approved", "sealed"]);
        if (!got) throw new CliExit(EXIT.usage, `${t.label} has no candidate or sealed revision`);
        const problems = await validate(ctx, got.doc);
        if (problems.length > 0) throw new CliExit(EXIT.invalid, `${t.label} ${got.rev}:\n${problems.join("\n")}`);
        return answer(
          { document: t.label, rev: got.rev, state: got.state, valid: true },
          `${t.label} ${got.rev} (${got.state}) is valid.`,
        );
      }),
    );

  testdata
    .command("seal")
    .argument("<app>", "the app ID")
    .description("freeze the candidate as a sealed revision (reviewer)")
    .action(
      act(ctxOf, (ctx, args) => sealDoc(ctx, target(ctx, appArg(args[0])), (doc) => validate(ctx, doc))),
    );

  testdata
    .command("approve")
    .argument("<app>", "the app ID")
    .requiredOption("--rev <n>", "the sealed revision to approve")
    .description("stamp a sealed revision (approver for this tenant, never its sealer)")
    .action(
      act(ctxOf, (ctx, args, opts) => approveDoc(ctx, target(ctx, appArg(args[0])), revOption(opts))),
    );
};
