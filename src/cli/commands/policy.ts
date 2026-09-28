// `intyy policy edit | check | seal | approve | effective`: the three policy layers.
// Follows design section 9 §8.6 and §7.1, and section 4 §4 (layers, merge, loader checks).
import type { Command } from "commander";
import { AppId, TenantId } from "../../core/model/common.js";
import { policyKind } from "../../core/model/kinds.js";
import type { AppPolicy, GlobalPolicy, Policy, TenantPolicy } from "../../core/model/policy.js";
import { mergePolicy, type MergeInput } from "../../core/safety/policy/merge.js";
import type { Ctx } from "../context.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer } from "../output.js";
import { act, type Register } from "../program.js";
import { settingsTarget } from "./settings.js";
import {
  approveDoc,
  editDoc,
  load,
  revOption,
  sealDoc,
  type DocTarget,
  type Loaded,
} from "./documents.js";

/** A layer name on the command line: `global`, `app:<app>`, or `tenant:<tenant>`. */
type Layer =
  { level: "global" } | { level: "app"; app: string } | { level: "tenant"; tenant: string };

/** Parses a layer name. Example: `tenant:keystone`. */
function parseLayer(name: string): Layer {
  if (name === "global") return { level: "global" };
  const [level, id] = name.split(":");
  if (level === "app" && id !== undefined && AppId.safeParse(id).success) return { level, app: id };
  if (level === "tenant" && id !== undefined && TenantId.safeParse(id).success)
    return { level, tenant: id };
  throw new CliExit(EXIT.usage, `layer ${name}: write global, app:<app>, or tenant:<tenant>`);
}

/** The store target for a layer. Global and app layers are shared, so their roles sit on `*`. */
function target(ctx: Ctx, layer: Layer): DocTarget<Policy> {
  const id =
    layer.level === "global"
      ? "global"
      : layer.level === "app"
        ? `app/${layer.app}`
        : `tenant/${layer.tenant}`;
  return {
    store: ctx.wiring.policy,
    kind: policyKind,
    id,
    label: `policy ${id.replace("/", ":")}`,
    scope: layer.level === "tenant" ? layer.tenant : "*",
  };
}

/** A parent layer to check against: approved first, then sealed, then the candidate. */
async function parent(
  ctx: Ctx,
  layer: Layer,
): Promise<(Loaded<Policy> & { label: string }) | undefined> {
  const t = target(ctx, layer);
  const got = await load(t, ["approved", "sealed", "candidate"]);
  return got
    ? { ...got, label: `${t.label.replace("policy ", "")} ${got.rev} (${got.state})` }
    : undefined;
}

/** Narrows a loaded policy to one level. A file stored under a level always has that level. */
function as<L extends Policy["scope"]["level"]>(
  p: Policy,
  level: L,
): Extract<Policy, { scope: { level: L } }> {
  if (p.scope.level !== level) throw new Error(`expected a ${level} layer, got ${p.scope.level}`);
  return p as Extract<Policy, { scope: { level: L } }>;
}

/**
 * Checks one layer against its parents with the merge (section 4 §4.8). A tenant layer is checked
 * once per app it names, and once with no app. Returns the problems and what it checked against.
 */
async function checkLayer(
  ctx: Ctx,
  doc: Policy,
): Promise<{ problems: string[]; against: string[] }> {
  const against: string[] = [];
  const runs: MergeInput[] = [];
  if (doc.scope.level === "global") {
    runs.push({ global: as(doc, "global") });
  } else {
    const g = await parent(ctx, { level: "global" });
    if (!g) return { problems: ["no global layer to check against"], against };
    against.push(g.label);
    const global: GlobalPolicy = as(g.doc, "global");
    if (doc.scope.level === "app") {
      runs.push({ global, app: as(doc, "app") });
    } else {
      const tenant: TenantPolicy = as(doc, "tenant");
      runs.push({ global, tenant });
      for (const appName of Object.keys(tenant.apps ?? {})) {
        const a = await parent(ctx, { level: "app", app: appName });
        if (a) against.push(a.label);
        const app: AppPolicy | undefined = a ? as(a.doc, "app") : undefined;
        runs.push(app ? { global, app, tenant, appName } : { global, tenant, appName });
      }
    }
  }
  const problems = new Set<string>();
  for (const input of runs) {
    const r = mergePolicy(input);
    if (!r.ok) for (const line of (r.detail ?? "").split("\n")) problems.add(line);
  }
  return { problems: [...problems], against };
}

/** A starting file for a new revision: the newest one with the revision counted up. */
function nextRevision(layer: Layer, base: Loaded<Policy> | undefined): unknown {
  if (base) {
    const next: Record<string, unknown> = {
      ...base.doc,
      revision: base.doc.revision + 1,
      reason: "",
    };
    delete next.approved;
    return next;
  }
  const scope =
    layer.level === "global"
      ? { level: "global" }
      : layer.level === "app"
        ? { level: "app", app: layer.app }
        : { level: "tenant", tenant: layer.tenant };
  return { schema: "intyy.policy/1.0", scope, revision: 1, reason: "" };
}

/** The first operand, which every policy verb but `effective` needs. */
function layerArg(args: string[]): Layer {
  const name = args[0];
  if (name === undefined)
    throw new CliExit(EXIT.usage, "name a layer: global, app:<app>, or tenant:<tenant>");
  return parseLayer(name);
}

/** The app `effective` merges for: `--app`, or the only app in the tenant's approved settings. */
async function effectiveApp(ctx: Ctx, opts: Record<string, unknown>): Promise<string | undefined> {
  if (typeof opts.app === "string") {
    if (!AppId.safeParse(opts.app).success)
      throw new CliExit(EXIT.usage, `--app ${opts.app}: an app ID is lower case`);
    return opts.app;
  }
  const settings = await load(settingsTarget(ctx), ["approved"]);
  const apps = Object.keys(settings?.doc.apps ?? {});
  return apps.length === 1 ? apps[0] : undefined;
}

/** Registers the policy commands. */
export const registerPolicy: Register = (program: Command, ctxOf) => {
  const policy = program
    .command("policy")
    .description("the three policy layers: global, app, tenant");

  policy
    .command("edit")
    .argument("<layer>", "global, app:<app>, or tenant:<tenant>")
    .description("open $EDITOR on the layer's candidate, then validate it")
    .action(
      act(ctxOf, (ctx, args) => {
        const layer = layerArg(args);
        return editDoc(
          ctx,
          target(ctx, layer),
          (base) => nextRevision(layer, base),
          async (doc) => {
            return (await checkLayer(ctx, doc)).problems;
          },
        );
      }),
    );

  policy
    .command("check")
    .argument("<layer>", "global, app:<app>, or tenant:<tenant>")
    .description("validate the candidate, or else the newest sealed revision; writes nothing")
    .action(
      act(ctxOf, async (ctx, args) => {
        const t = target(ctx, layerArg(args));
        const got = await load(t, ["candidate", "approved", "sealed"]);
        if (!got) throw new CliExit(EXIT.usage, `${t.label} has no candidate or sealed revision`);
        const { problems, against } = await checkLayer(ctx, got.doc);
        if (problems.length > 0)
          throw new CliExit(EXIT.invalid, `${t.label} ${got.rev}:\n${problems.join("\n")}`);
        const checked = against.length > 0 ? ` Checked against ${against.join(", ")}.` : "";
        return answer(
          {
            document: t.label,
            rev: got.rev,
            state: got.state,
            valid: true,
            checked_against: against,
          },
          `${t.label} ${got.rev} (${got.state}) is valid.${checked}`,
        );
      }),
    );

  policy
    .command("seal")
    .argument("<layer>", "global, app:<app>, or tenant:<tenant>")
    .description("freeze the candidate as a sealed revision (reviewer)")
    .action(
      act(ctxOf, (ctx, args) =>
        sealDoc(
          ctx,
          target(ctx, layerArg(args)),
          async (doc) => (await checkLayer(ctx, doc)).problems,
        ),
      ),
    );

  policy
    .command("approve")
    .argument("<layer>", "global, app:<app>, or tenant:<tenant>")
    .requiredOption("--rev <n>", "the sealed revision to approve")
    .description("stamp a sealed revision (approver, never its sealer)")
    .action(
      act(ctxOf, (ctx, args, opts) =>
        approveDoc(ctx, target(ctx, layerArg(args)), revOption(opts)),
      ),
    );

  policy
    .command("effective")
    .option("--app <app>", "the app to merge for (default: the only app in the tenant's settings)")
    .description("merge the approved layers that exist and print the rules and their hash")
    .action(
      act(ctxOf, async (ctx, _args, opts) => {
        const appName = await effectiveApp(ctx, opts);
        const g = await load(target(ctx, { level: "global" }), ["approved"]);
        if (!g) throw new CliExit(EXIT.invalid, "policy global has no approved revision");
        const a =
          appName === undefined
            ? undefined
            : await load(target(ctx, { level: "app", app: appName }), ["approved"]);
        const t = await load(target(ctx, { level: "tenant", tenant: ctx.tenant }), ["approved"]);
        const input: MergeInput = { global: as(g.doc, "global") };
        if (a) input.app = as(a.doc, "app");
        if (t) input.tenant = as(t.doc, "tenant");
        if (appName !== undefined) input.appName = appName;
        const merged = mergePolicy(input);
        if (!merged.ok)
          throw new CliExit(EXIT.invalid, `effective policy:\n${merged.detail ?? ""}`);
        const missing = [...merged.value.missing, ...(t ? [] : [`tenant:${ctx.tenant}`])];
        const layers = Object.entries(merged.value.layers).map(([k, v]) => `${k} ${String(v)}`);
        const lines = [
          `layers: ${layers.join(", ")}`,
          ...(missing.length > 0
            ? [`missing: ${missing.join(", ")} (no approved revision yet)`]
            : []),
          `hash: ${merged.value.hash}`,
          "Use --json for the full rules.",
        ];
        return answer(
          {
            tenant: ctx.tenant,
            app: appName ?? null,
            layers: merged.value.layers,
            missing,
            hash: merged.value.hash,
            effective: merged.value.effective,
          },
          lines.join("\n"),
        );
      }),
    );
};
