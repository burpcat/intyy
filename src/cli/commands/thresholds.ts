// `intyy thresholds edit | check | seal | approve | show <app>` and `intyy jev report <app>`: the
// jev confidence cutoffs per app and jev version, and the table of labelled jev calls.
// Follows design section 9 §9.5 and §7.1, section 5 §10.4, and section 8 §14.1.
import type { Command } from "commander";
import { jevTable } from "../../core/certify/jev-table.js";
import { AppId } from "../../core/model/common.js";
import { thresholdsKind } from "../../core/model/kinds.js";
import {
  checkThresholds,
  DEFAULT_CUTOFFS,
  JevVersion,
  type Thresholds,
} from "../../core/model/thresholds.js";
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

/** Parses `--jev <version>`. `undefined` when the flag is absent. */
function jevOption(opts: Record<string, unknown>, required: boolean): string | undefined {
  const raw = opts.jev;
  if (raw === undefined) {
    if (required) throw new CliExit(EXIT.usage, "--jev takes a jev version, like --jev jev@1.4.2");
    return undefined;
  }
  const parsed = JevVersion.safeParse(raw);
  if (!parsed.success)
    throw new CliExit(EXIT.usage, "--jev takes a jev version, like --jev jev@1.4.2");
  return parsed.data;
}

/** One app and jev version's threshold record. Shared across tenants, so roles sit on `*` (like faults). */
export function target(ctx: Ctx, app: string, jev: string): DocTarget<Thresholds> {
  const id = `${app}/${jev}`;
  return {
    store: ctx.wiring.thresholds,
    kind: thresholdsKind,
    id,
    label: `thresholds ${id}`,
    scope: "*",
  };
}

const validate = (doc: Thresholds): Promise<string[]> => Promise.resolve(checkThresholds(doc));

/** A fresh candidate: the previous revision counted up, or the starting values (section 5 §10.4). */
function nextRevision(app: string, jev: string, base: Loaded<Thresholds> | undefined): unknown {
  if (base) {
    const next: Record<string, unknown> = { ...base.doc, revision: base.doc.revision + 1 };
    delete next.approved;
    return next;
  }
  return { schema: "intyy.thresholds/1.0", app, jev_version: jev, revision: 1, ...DEFAULT_CUTOFFS };
}

/** Every jev version that has a record for `app`, from the store's listing. */
async function versionsOf(ctx: Ctx, app: string): Promise<string[]> {
  const all = await ctx.wiring.thresholds.list({});
  const prefix = `${app}/`;
  const versions = all.filter((s) => s.id.startsWith(prefix)).map((s) => s.id.slice(prefix.length));
  return [...new Set(versions)].sort();
}

const REQUIRED_JEV = ["--jev <version>", "the jev version, like jev@1.4.2"] as const;

/** Registers the thresholds commands. */
export const registerThresholds: Register = (program: Command, ctxOf) => {
  const thresholds = program
    .command("thresholds")
    .description("jev confidence cutoffs, per app and jev version");

  thresholds
    .command("edit")
    .argument("<app>", "the app ID")
    .requiredOption(...REQUIRED_JEV)
    .description("open $EDITOR on the threshold candidate, then validate it")
    .action(
      act(ctxOf, (ctx, args, opts) => {
        const app = appArg(args[0]);
        const jev = jevOption(opts, true) ?? "";
        return editDoc(
          ctx,
          target(ctx, app, jev),
          (base) => nextRevision(app, jev, base),
          validate,
        );
      }),
    );

  thresholds
    .command("check")
    .argument("<app>", "the app ID")
    .requiredOption(...REQUIRED_JEV)
    .description("validate the candidate, or else the newest sealed revision; writes nothing")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const t = target(ctx, appArg(args[0]), jevOption(opts, true) ?? "");
        const got = await load(t, ["candidate", "approved", "sealed"]);
        if (!got) throw new CliExit(EXIT.usage, `${t.label} has no candidate or sealed revision`);
        const problems = await validate(got.doc);
        if (problems.length > 0)
          throw new CliExit(EXIT.invalid, `${t.label} ${got.rev}:\n${problems.join("\n")}`);
        return answer(
          { document: t.label, rev: got.rev, state: got.state, valid: true },
          `${t.label} ${got.rev} (${got.state}) is valid.`,
        );
      }),
    );

  thresholds
    .command("seal")
    .argument("<app>", "the app ID")
    .requiredOption(...REQUIRED_JEV)
    .description("freeze the candidate as a sealed revision (reviewer)")
    .action(
      act(ctxOf, (ctx, args, opts) =>
        sealDoc(ctx, target(ctx, appArg(args[0]), jevOption(opts, true) ?? ""), validate),
      ),
    );

  thresholds
    .command("approve")
    .argument("<app>", "the app ID")
    .requiredOption(...REQUIRED_JEV)
    .requiredOption("--rev <n>", "the sealed revision to approve")
    .description("stamp a sealed revision (approver, never its sealer)")
    .action(
      act(ctxOf, (ctx, args, opts) =>
        approveDoc(ctx, target(ctx, appArg(args[0]), jevOption(opts, true) ?? ""), revOption(opts)),
      ),
    );

  thresholds
    .command("show")
    .argument("<app>", "the app ID")
    .option(
      "--jev <version>",
      "one jev version, like jev@1.4.2 (default: every version with a record)",
    )
    .description("the app-level threshold record: the newest approved, else sealed, else candidate")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const app = appArg(args[0]);
        const only = jevOption(opts, false);
        const versions = only === undefined ? await versionsOf(ctx, app) : [only];
        const records: {
          jev_version: string;
          rev: string;
          state: string;
          handler_min: number;
          outcome_min: number;
          reconciliation_min: number;
        }[] = [];
        for (const v of versions) {
          const got = await load(target(ctx, app, v), ["approved", "sealed", "candidate"]);
          if (!got) continue;
          const { handler_min, outcome_min, reconciliation_min } = got.doc;
          records.push({
            jev_version: v,
            rev: got.rev,
            state: got.state,
            handler_min,
            outcome_min,
            reconciliation_min,
          });
        }
        // Why only the app-level record: context tightenings arrive with the score store (M10).
        const text =
          records.length === 0
            ? `No threshold record for ${app}. The starting values apply: handler_min ${String(DEFAULT_CUTOFFS.handler_min)}, outcome_min ${String(DEFAULT_CUTOFFS.outcome_min)}, reconciliation_min ${String(DEFAULT_CUTOFFS.reconciliation_min)}.`
            : records
                .map(
                  (r) =>
                    `${app} ${r.jev_version} rev ${r.rev} (${r.state}): handler_min ${String(r.handler_min)}, outcome_min ${String(r.outcome_min)}, reconciliation_min ${String(r.reconciliation_min)}`,
                )
                .join("\n");
        return answer({ app, records, defaults: DEFAULT_CUTOFFS }, text);
      }),
    );
};

/** Registers `jev report`. */
export const registerJev: Register = (program: Command, ctxOf) => {
  const jev = program.command("jev").description("jev, the error sorter on rung 2");

  jev
    .command("report")
    .argument("<app>", "the app ID")
    .option("--jev <version>", "one jev version, like jev@1.4.2")
    .description("pooled, labelled jev calls per answer type: right, wrong, below threshold")
    .action(
      act(ctxOf, (_ctx, args, opts) => {
        const app = appArg(args[0]);
        const version = jevOption(opts, false);
        // Why an empty list: certify reports hold no jev table yet. M10 pools labelled calls
        // into the score store; until then every row is zero.
        const rows = jevTable([]);
        const header = "answer         right  wrong  below_threshold";
        const lines = rows.map(
          (r) =>
            `${r.answer.padEnd(14)} ${String(r.right).padStart(5)}  ${String(r.wrong).padStart(5)}  ${String(r.below_threshold).padStart(15)}`,
        );
        return Promise.resolve(
          answer(
            { app, jev_version: version ?? null, calls: 0, rows },
            [
              `jev calls for ${app}${version === undefined ? "" : ` (${version})`}: 0 labelled`,
              header,
              ...lines,
            ].join("\n"),
          ),
        );
      }),
    );
};
