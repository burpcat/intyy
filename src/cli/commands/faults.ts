// `intyy faults edit | check | seal | approve <app>`: the app's fault profile set.
// Follows design section 9 §8.7 and section 8 §6.3 (fault profile set).
import type { Command } from "commander";
import { AppId } from "../../core/model/common.js";
import { checkFaults, type Faults } from "../../core/model/faults.js";
import { faultsKind } from "../../core/model/kinds.js";
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

/** Parses `<app>`. */
function appArg(text: string | undefined): string {
  const parsed = AppId.safeParse(text ?? "");
  if (!parsed.success) throw new CliExit(EXIT.usage, "app: write a lower-case app ID, like kvfcu");
  return parsed.data;
}

/** One app's fault profiles, shared across every tenant (section 9 §8.7). */
function target(ctx: Ctx, app: string): DocTarget<Faults> {
  return { store: ctx.wiring.faults, kind: faultsKind, id: app, label: `faults ${app}`, scope: "*" };
}

const validate = (doc: Faults): Promise<string[]> => Promise.resolve(checkFaults(doc));

/** A fresh candidate: the previous sealed revision counted up, or an empty skeleton. */
function nextRevision(app: string, base: Loaded<Faults> | undefined): unknown {
  if (base) {
    const next: Record<string, unknown> = { ...base.doc, revision: base.doc.revision + 1 };
    delete next.approved;
    return next;
  }
  return { schema: "intyy.faults/1.0", app, revision: 1, profiles: [] };
}

/** Registers the faults commands. */
export const registerFaults: Register = (program: Command, ctxOf) => {
  const faults = program
    .command("faults")
    .description("fault profiles: which faults an app's harness can inject, and how each must end");

  faults
    .command("edit")
    .argument("<app>", "the app ID")
    .description("open $EDITOR on the app's fault profile candidate, then validate it")
    .action(
      act(ctxOf, (ctx, args) => {
        const app = appArg(args[0]);
        return editDoc(ctx, target(ctx, app), (base) => nextRevision(app, base), validate);
      }),
    );

  faults
    .command("check")
    .argument("<app>", "the app ID")
    .description("validate the candidate, or else the newest sealed revision; writes nothing")
    .action(
      act(ctxOf, async (ctx, args) => {
        const t = target(ctx, appArg(args[0]));
        const got = await load(t, ["candidate", "approved", "sealed"]);
        if (!got) throw new CliExit(EXIT.usage, `${t.label} has no candidate or sealed revision`);
        const problems = await validate(got.doc);
        if (problems.length > 0) throw new CliExit(EXIT.invalid, `${t.label} ${got.rev}:\n${problems.join("\n")}`);
        return answer(
          { document: t.label, rev: got.rev, state: got.state, valid: true },
          `${t.label} ${got.rev} (${got.state}) is valid.`,
        );
      }),
    );

  faults
    .command("seal")
    .argument("<app>", "the app ID")
    .description("freeze the candidate as a sealed revision (reviewer)")
    .action(act(ctxOf, (ctx, args) => sealDoc(ctx, target(ctx, appArg(args[0])), validate)));

  faults
    .command("approve")
    .argument("<app>", "the app ID")
    .requiredOption("--rev <n>", "the sealed revision to approve")
    .description("stamp a sealed revision (approver, never its sealer)")
    .action(
      act(ctxOf, (ctx, args, opts) => approveDoc(ctx, target(ctx, appArg(args[0])), revOption(opts))),
    );
};
