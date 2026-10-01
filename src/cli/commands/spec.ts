// `intyy spec new | edit | check`: run spec files under `library/specs/<app>/<name>.json`.
// Follows design section 9 §8.1 (commands and roles) and section 6 §6 and §7.2 (fields and checks).
// Spec files are plain files reviewed in git, not sealed documents.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { AppId } from "../../core/model/common.js";
import { MajorCapabilityLink } from "../../core/model/artifact/shared.js";
import { CapabilityName, RunSpec } from "../../core/model/runspec.js";
import { issueText } from "../../core/model/sealing.js";
import { checkSpec, type SpecReport } from "../../core/discovery/spec-checks.js";
import type { SpecLookup } from "../../core/recorder/candidates.js";
import { fail, ok } from "../../ports/outcome.js";
import { readChecked, requireRole, type Ctx } from "../context.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer, progress, type Answer } from "../output.js";
import { act, type Register } from "../program.js";
import { load, runEditor } from "./documents.js";
import { effectivePolicy } from "./policy.js";
import { settingsTarget } from "./settings.js";

/**
 * A spec name on the command line: `<app>/<name>`. Example: `kvfcu/sign_in`. `name` may add a
 * dotted variant suffix, like `open_share_subaccount.missing`: the same capability's alternate
 * scenario file (docs/decisions.md, M05). `capability` is `name` with that suffix stripped, the
 * value the spec's own `capability` field takes.
 */
export type SpecName = { app: string; name: string; capability: string };

/** Parses `<app>/<name>`, `name` alone or `name.variant`. */
export function parseSpecName(arg: string | undefined): SpecName {
  const [app, name, extra] = (arg ?? "").split("/");
  const capability = name?.split(".")[0];
  if (
    extra !== undefined ||
    name === undefined ||
    !AppId.safeParse(app).success ||
    !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/.test(name) ||
    !CapabilityName.safeParse(capability).success
  ) {
    throw new CliExit(
      EXIT.usage,
      `spec ${arg ?? ""}: write <app>/<name>, like kvfcu/sign_in or kvfcu/open_share_subaccount.missing`,
    );
  }
  return { app: app ?? "", name, capability: capability ?? "" };
}

/** Where a spec file lives (section 6 §6). */
export function specPath(ctx: Ctx, s: SpecName): string {
  return join(ctx.root, ctx.config.library, "specs", s.app, `${s.name}.json`);
}

/** Today in `timeZone`, as `YYYY-MM-DD`. The `en-CA` locale prints dates in that order. */
function todayIn(ctx: Ctx, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(ctx.wiring.clock.now());
}

/** Runs every section 6 rule on a spec, with facts from settings, policy, and config. */
export async function reportFor(ctx: Ctx, spec: RunSpec): Promise<SpecReport> {
  const settings = await load(settingsTarget(ctx), ["approved"]);
  const app = settings?.doc.apps[spec.app];
  const policy = await effectivePolicy(ctx, spec.app);
  const r = checkSpec(spec, {
    today: todayIn(ctx, app?.time_zone ?? "UTC"),
    canaries: ctx.config.canary_members,
    labels: policy.effective.redaction.labels,
    environment: app?.environment ?? null,
    correlationNotesAllowed: policy.effective.correlation.notes,
  });
  if (spec.caller.tenant !== ctx.tenant)
    r.problems.push(`caller: tenant ${spec.caller.tenant} is not this tenant, ${ctx.tenant}`);
  return r;
}

/**
 * The skeleton `spec new` writes. Its goal is empty, so it fails `check` until the operator
 * writes one. The operator also fills in the inputs, outputs, and (for a negative spec)
 * `expected_outcome`. `session` and `negative` are the two fields a fresh skeleton cannot guess
 * (docs/decisions.md, M05): the rest stay the operator's to fill in through `spec edit`.
 */
function skeleton(
  ctx: Ctx,
  s: SpecName,
  staff: string,
  opts: { session: string | null; negative: boolean },
): Record<string, unknown> {
  return {
    schema: "intyy.runspec/1.0",
    kind: opts.negative ? "negative_discovery" : "discovery",
    caller: { tenant: ctx.tenant, agent_id: staff },
    app: s.app,
    capability: s.capability,
    goal: "",
    inputs: [],
    outputs: [],
    expected_effect: "read_only",
    session: opts.session,
    entry: "/",
    model: "claude-sonnet-5",
    prompt: "discovery@1.1",
  };
}

/** Prints the warnings, then returns the answer for a clean report or exits 7 on problems. */
function finish(ctx: Ctx, label: string, r: SpecReport, done: string): Answer {
  for (const w of r.warnings) progress(ctx.io, `warning: ${w}`);
  if (r.problems.length > 0) throw new CliExit(EXIT.invalid, `${label}:\n${r.problems.join("\n")}`);
  return answer({ spec: label, valid: true, warnings: r.warnings }, done);
}

/** Reads a spec file and checks its schema. A bad file exits 7. */
export function readSpec(ctx: Ctx, s: SpecName): RunSpec {
  const path = specPath(ctx, s);
  if (!existsSync(path)) throw new CliExit(EXIT.usage, `spec ${s.app}/${s.name} does not exist`);
  return readChecked(path, RunSpec);
}

/** A {@link SpecLookup} bound to this command's root: what `src/core/recorder/candidates.ts`
 * uses to read a linked run's spec, without a `node:fs` import of its own (CLAUDE.md). */
export function specLookup(ctx: Ctx): SpecLookup {
  return (app, name) => {
    try {
      return Promise.resolve(ok(readSpec(ctx, { app, name, capability: name })));
    } catch (e) {
      if (e instanceof CliExit) return Promise.resolve(fail(e.code === EXIT.invalid ? "invalid" : "not_found", e.message));
      throw e;
    }
  };
}

/** Registers the spec commands. */
export const registerSpec: Register = (program: Command, ctxOf) => {
  const spec = program.command("spec").description("run specs: what one discovery run must do");

  spec
    .command("new")
    .argument("<app/name>", "the app and proposed capability, like kvfcu/sign_in")
    .option("--session <link>", "the session capability this run needs first, like kvfcu/sign_in@1")
    .option("--negative", "a negative_discovery spec, attached later to an existing candidate")
    .description("write a spec skeleton (operator)")
    .action(
      act(ctxOf, (ctx, args, opts) => {
        const s = parseSpecName(args[0]);
        const staff = requireRole(ctx, ctx.tenant, "operator");
        const path = specPath(ctx, s);
        if (existsSync(path))
          throw new CliExit(EXIT.refused, `spec ${s.app}/${s.name} already exists`);
        let session: string | null = null;
        if (typeof opts.session === "string") {
          if (!MajorCapabilityLink.safeParse(opts.session).success) {
            throw new CliExit(EXIT.usage, `--session ${opts.session}: write a link like kvfcu/sign_in@1`);
          }
          session = opts.session;
        }
        mkdirSync(dirname(path), { recursive: true });
        const doc = skeleton(ctx, s, staff, { session, negative: opts.negative === true });
        writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { flag: "wx" });
        return Promise.resolve(
          answer(
            { spec: `${s.app}/${s.name}`, path },
            `Wrote ${path}.\nFill it in with: intyy spec edit ${s.app}/${s.name}`,
          ),
        );
      }),
    );

  spec
    .command("edit")
    .argument("<app/name>", "the spec to edit")
    .description("open $EDITOR on the spec, then check it; a bad edit is not saved (operator)")
    .action(
      act(ctxOf, async (ctx, args) => {
        const s = parseSpecName(args[0]);
        requireRole(ctx, ctx.tenant, "operator");
        const path = specPath(ctx, s);
        if (!existsSync(path))
          throw new CliExit(EXIT.usage, `spec ${s.app}/${s.name} does not exist`);
        const before = readFileSync(path, "utf8");
        mkdirSync(ctx.wiring.tmpDir, { recursive: true });
        const tmp = join(ctx.wiring.tmpDir, `edit-spec-${s.app}-${s.name}-${randomUUID()}.json`);
        writeFileSync(tmp, before);
        runEditor(ctx, tmp);
        const kept = `The edit is kept at ${tmp}`;
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(tmp, "utf8"));
        } catch {
          throw new CliExit(EXIT.invalid, `spec ${s.app}/${s.name}: not valid JSON. ${kept}`);
        }
        const parsed = RunSpec.safeParse(raw);
        if (!parsed.success)
          throw new CliExit(
            EXIT.invalid,
            `spec ${s.app}/${s.name}: ${issueText(parsed.error)}. ${kept}`,
          );
        const r = await reportFor(ctx, parsed.data);
        if (r.problems.length > 0) r.problems.push(kept);
        const out = finish(ctx, `spec ${s.app}/${s.name}`, r, `spec ${s.app}/${s.name} saved.`);
        writeFileSync(path, `${JSON.stringify(parsed.data, null, 2)}\n`);
        rmSync(tmp, { force: true });
        return out;
      }),
    );

  spec
    .command("check")
    .argument("<app/name>", "the spec to check")
    .description("check the schema and the section 6 rules; writes nothing")
    .action(
      act(ctxOf, async (ctx, args) => {
        const s = parseSpecName(args[0]);
        const r = await reportFor(ctx, readSpec(ctx, s));
        return finish(ctx, `spec ${s.app}/${s.name}`, r, `spec ${s.app}/${s.name} is valid.`);
      }),
    );
};
