// `intyy suite edit | check | seal | approve <app>/<capability>@<major>`: the certify suite files.
// Follows design section 9 §8.7 and section 8 §6.1 (suite file).
import type { Command } from "commander";
import { suiteKind } from "../../core/model/kinds.js";
import { CapabilityMajor, checkSuite, type Suite } from "../../core/model/suite.js";
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

/** Parses `<app>/<capability>@<major>`, also the suite's store ID (section 8 §6.1). */
function capabilityArg(text: string | undefined): string {
  const parsed = CapabilityMajor.safeParse(text ?? "");
  if (!parsed.success) {
    throw new CliExit(
      EXIT.usage,
      "capability: write app/capability@major, like kvfcu/open_share_subaccount@1",
    );
  }
  return parsed.data;
}

/** A suite names no tenant: every approver on `*` may seal and approve it (section 9 §8.7). */
function target(ctx: Ctx, capability: string): DocTarget<Suite> {
  return {
    store: ctx.wiring.suites,
    kind: suiteKind,
    id: capability,
    label: `suite ${capability}`,
    scope: "*",
  };
}

/** Section 8 §6.1's self-contained loader checks; the artifact-driven "extra names a missing
 * step" check waits for the certify runner (M06 task 8). */
const validate = (doc: Suite): Promise<string[]> => Promise.resolve(checkSuite(doc));

/** A fresh candidate: the previous sealed revision counted up, or an empty skeleton. */
function nextRevision(capability: string, base: Loaded<Suite> | undefined): unknown {
  if (base) {
    const next: Record<string, unknown> = { ...base.doc, revision: base.doc.revision + 1, reason: "" };
    delete next.approved;
    return next;
  }
  return {
    schema: "intyy.suite/1.0",
    capability,
    revision: 1,
    reason: "",
    classes: [],
    matrix: { class: "", profiles: "standard" },
    stability: { class: "", levels: [0.05, 0.15, 0.3], seeds: 5, twins: true },
    drills: { count: 0 },
    extra: [],
    setup: [],
    provenance: { runs: [], decisions: [], sealed: null },
  };
}

/** Registers the suite commands. */
export const registerSuite: Register = (program: Command, ctxOf) => {
  const suite = program
    .command("suite")
    .description("certify suites: input classes, the fault matrix, and extra cases");

  suite
    .command("edit")
    .argument("<capability>", "app/capability@major")
    .description("open $EDITOR on the capability's suite candidate, then validate it")
    .action(
      act(ctxOf, (ctx, args) => {
        const capability = capabilityArg(args[0]);
        return editDoc(ctx, target(ctx, capability), (base) => nextRevision(capability, base), validate);
      }),
    );

  suite
    .command("check")
    .argument("<capability>", "app/capability@major")
    .description("validate the candidate, or else the newest sealed revision; writes nothing")
    .action(
      act(ctxOf, async (ctx, args) => {
        const t = target(ctx, capabilityArg(args[0]));
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

  suite
    .command("seal")
    .argument("<capability>", "app/capability@major")
    .description("freeze the candidate as a sealed revision (reviewer)")
    .action(act(ctxOf, (ctx, args) => sealDoc(ctx, target(ctx, capabilityArg(args[0])), validate)));

  suite
    .command("approve")
    .argument("<capability>", "app/capability@major")
    .requiredOption("--rev <n>", "the sealed revision to approve")
    .description("stamp a sealed revision (approver, never its sealer)")
    .action(
      act(ctxOf, (ctx, args, opts) => approveDoc(ctx, target(ctx, capabilityArg(args[0])), revOption(opts))),
    );
};
