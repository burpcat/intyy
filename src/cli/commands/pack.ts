// `intyy pack edit | check | seal | approve | dry-run | second-look`: the handler pack files.
// Follows design section 9 §8.5 and section 5 §5 (pack file), §7 (scope, merge, frozen set).
import type { Command } from "commander";
import { checkPack, type PackCheckContext } from "../../core/packs/checks.js";
import { packImpact, uncovered } from "../../core/trust/pack-impact.js";
import { handlerFiresOn } from "../../core/packs/fixture-suite.js";
import { buildFrozenSet, type FrozenSet, type PackLayer } from "../../core/packs/merge.js";
import { packKind } from "../../core/model/kinds.js";
import { matchPath, normalizePath, parsePattern } from "../../core/safety/policy/paths.js";
import {
  packScopeId,
  packScopeText,
  parentScopes,
  parsePackScopeArg,
  type Decision,
  type Pack,
  type PackScope,
} from "../../core/model/pack.js";
import type { HandlerDraft } from "../../core/model/handler-draft.js";
import type { Ctx } from "../context.js";
import { requireRole, requireStaff } from "../context.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer } from "../output.js";
import { act, type Register } from "../program.js";
import {
  approveDoc,
  editDoc,
  load,
  orExit,
  readSealed,
  revOption,
  sealDoc,
  type DocTarget,
  type Loaded,
} from "./documents.js";
import { listFixtures } from "./fixtures-fs.js";
import { effectivePolicy } from "./policy.js";
import { driftTenants, scoreDeps } from "./trust-shared.js";

/** Parses the `<scope>` argument (section 9 §8.5). */
function scopeArg(text: string | undefined): PackScope {
  const parsed = parsePackScopeArg(text ?? "");
  if (parsed === null) {
    throw new CliExit(
      EXIT.usage,
      "scope: write global, app:<app>, app_version:<app>:<pattern>, or tenant:<tenant>:<app>",
    );
  }
  return parsed;
}

/** Who may seal and approve a scope: a tenant pack belongs to that tenant; the rest are shared. */
function scopeRole(scope: PackScope): string {
  return scope.level === "tenant" ? scope.tenant : "*";
}

/** The document-store target for one scope. */
export function target(ctx: Ctx, scope: PackScope): DocTarget<Pack> {
  const id = packScopeId(scope);
  return { store: ctx.wiring.packs, kind: packKind, id, label: `pack ${id}`, scope: scopeRole(scope) };
}

/** Loads one scope's active (approved, else sealed) revision, if any. */
export async function loadAncestor(ctx: Ctx, scope: PackScope): Promise<Pack | undefined> {
  const got = await load(target(ctx, scope), ["approved", "sealed"]);
  return got?.doc;
}

/** The active pack layers of one tenant and app, general to specific: global, app, and tenant scope (section 5 §7.4). */
export async function activeLayers(ctx: Ctx, tenant: string, app: string): Promise<PackLayer[]> {
  const scopes: PackScope[] = [{ level: "global" }, { level: "app", app }, { level: "tenant", tenant, app }];
  const layers: PackLayer[] = [];
  for (const scope of scopes) {
    const found = await loadAncestor(ctx, scope);
    if (found !== undefined) layers.push({ scope, revision: found.revision, pack: found });
  }
  return layers;
}

/** Reads `<scope>@<rev>` (`app:kvfcu@5`) as a candidate layer: a sealed or approved revision, hash-checked. */
export async function readCandidateLayer(ctx: Ctx, text: string | undefined): Promise<{ layer: PackLayer; label: string }> {
  const at = (text ?? "").lastIndexOf("@");
  const rev = at < 0 ? "" : (text ?? "").slice(at + 1);
  if (at < 0 || !/^[1-9]\d*$/.test(rev)) throw new CliExit(EXIT.usage, "name a pack revision like app:kvfcu@5");
  const scope = scopeArg((text ?? "").slice(0, at));
  const t = target(ctx, scope);
  const got = await readSealed(t, rev);
  return { layer: { scope, revision: got.doc.revision, pack: got.doc }, label: `${packScopeText(scope)}@${rev}` };
}

/**
 * The frozen set for one app, tenant, and app version (section 5 §7.4): global, app, and tenant
 * scope, each at its active revision, merged. No `app_version`-scope pack exists in this build
 * (M06's owner decision: "no pack files → empty frozen set"), so that scope is not tried.
 * `candidate adopt` uses this to check a handler exists and fires before adopting it.
 */
export async function loadFrozenSetFor(ctx: Ctx, tenant: string, app: string, appVersion: string): Promise<FrozenSet> {
  const layers = await activeLayers(ctx, tenant, app);
  const result = buildFrozenSet(layers, { appVersion });
  if (!result.ok) throw new CliExit(EXIT.invalid, `frozen set: ${result.detail ?? result.failure}`);
  return result.value;
}

/** Every ID ancestor scopes' active revisions declare, for section 5 §5.6's reference and
 * overrides checks. Global has none; every other scope's ancestors are section 5 §7.1's chain. */
async function ancestorContext(ctx: Ctx, scope: PackScope): Promise<PackCheckContext> {
  const ancestors = await Promise.all(parentScopes(scope).map((s) => loadAncestor(ctx, s)));
  const packs = ancestors.filter((p): p is Pack => p !== undefined);
  const targetIds = new Set(packs.flatMap((p) => p.targets.map((t) => t.id)));
  const conditionIds = new Set(packs.flatMap((p) => p.conditions.map((c) => c.id)));
  const handlerIds = new Set(packs.flatMap((p) => p.handlers.map((h) => h.id)));
  const ctxOut: PackCheckContext = {
    ancestorTargetIds: targetIds,
    ancestorConditionIds: conditionIds,
    ancestorHandlerIds: handlerIds,
  };
  if (scope.level === "global") return ctxOut;
  const merged = await effectivePolicy(ctx, scope.app).catch(() => undefined);
  if (merged === undefined) return ctxOut;
  ctxOut.secretDeclared = (name) => name in merged.effective.secrets;
  ctxOut.pathAllowed = (p) => {
    const norm = normalizePath(p, false);
    if (!norm.ok) return false;
    return merged.effective.paths.allow.some((pattern) => {
      const parsed = parsePattern(pattern);
      return parsed.ok && matchPath(parsed.value, norm.value, merged.effective.paths.case_sensitive);
    });
  };
  return ctxOut;
}

/** Section 5 §5.6's loader checks, with whatever ancestor and policy context is available. */
async function checkLoader(ctx: Ctx, doc: Pack): Promise<string[]> {
  const packCtx = await ancestorContext(ctx, doc.scope);
  return checkPack(doc, packCtx).map((p) => `${p.code}: ${p.path}: ${p.message}`);
}

/**
 * Section 5 §5.4's second point: sealing a pack needs a second look for every declared risk
 * flag. A pack response action's `risk` may only be `idempotent` or `reversible` (never
 * `irreversible`, section 5 §5.6), so every declared value is itself a lowering from the rules'
 * own strictest default; this checks each one has a `risk_second_look` decision confirming it,
 * by a staff ID other than whoever made the `risk` decision (section 9 §8.3, mirrored for packs
 * by owner decision, docs/decisions.md, M06, 2026-09-30).
 */
function checkSecondLooks(doc: Pack): string[] {
  const problems: string[] = [];
  const decisions = doc.provenance.decisions;
  for (const h of doc.handlers) {
    if (h.class !== "recoverable") continue;
    h.response.forEach((_action, i) => {
      const subject = `${h.id}.response[${String(i)}]`;
      const risk = [...decisions].reverse().find((d) => d.what === "risk" && d.subject === subject);
      if (risk === undefined) return; // already a loader problem: missing_risk_decision
      const confirmed = decisions.some(
        (d) => d.what === "risk_second_look" && d.subject === subject && d.value === risk.value && d.by !== risk.by,
      );
      if (!confirmed) {
        problems.push(`missing_second_look: ${subject}: needs pack second-look --agree from another reviewer`);
      }
    });
  }
  return problems;
}

/** `edit`, `check`: loader checks only. `seal`: loader checks plus the second-look rule. */
async function checkForSeal(ctx: Ctx, doc: Pack): Promise<string[]> {
  return [...(await checkLoader(ctx, doc)), ...checkSecondLooks(doc)];
}

/** The risk value `handler.response[i]` had in `base`, or `undefined` for a new handler or a
 * new action: there is nothing to compare it with (owner decision, docs/decisions.md, M06:
 * "or with the rules' class for a new action" — a pack action has no live screen to class
 * against, so a first-seen value is itself the thing needing a stamp). */
function priorRisk(base: Pack | undefined, handlerId: string, actionIndex: number): string | undefined {
  const h = base?.handlers.find((x) => x.id === handlerId);
  return h?.class === "recoverable" ? h.response[actionIndex]?.risk : undefined;
}

/**
 * `pack edit`'s auto-stamp (owner decision, docs/decisions.md, M06, 2026-09-30): every new or
 * changed response-action risk gets a `risk` decision stamped with the editing staff ID and the
 * clock time. The edited file's own `provenance.decisions` is never trusted directly — only
 * `base`'s decisions, plus what this stamp computes, survive: "a hand-written entry the editor
 * did not make must not be trusted."
 */
function stampRiskDecisions(doc: Pack, base: Pack | undefined, staff: string, now: string): Pack {
  const kept: Decision[] = [...(base?.provenance.decisions ?? [])];
  const fresh: Decision[] = [];
  for (const h of doc.handlers) {
    if (h.class !== "recoverable") continue;
    h.response.forEach((action, i) => {
      const subject = `${h.id}.response[${String(i)}]`;
      if (action.risk !== priorRisk(base, h.id, i)) {
        fresh.push({ what: "risk", subject, value: action.risk, by: staff, at: now });
      }
    });
  }
  return { ...doc, provenance: { ...doc.provenance, decisions: [...kept, ...fresh] } };
}

/** A fresh candidate: the previous sealed revision counted up, or an empty skeleton. */
function nextRevision(scope: PackScope, base: Loaded<Pack> | undefined): unknown {
  if (base) {
    const next: Record<string, unknown> = { ...base.doc, revision: base.doc.revision + 1, reason: "" };
    delete next.approved;
    (next.provenance as Record<string, unknown>) = { ...base.doc.provenance, sealed: null };
    return next;
  }
  return {
    schema: "intyy.pack/1.0",
    scope,
    revision: 1,
    reason: "",
    targets: [],
    conditions: [],
    handlers: [],
    provenance: { runs: [], decisions: [], sealed: null },
  };
}

/** `pack dry-run --fixtures` (section 9 §8.5): which detectors fire on which saved fixture. */
async function dryRunFixtures(ctx: Ctx, doc: Pack): Promise<{ fixtureId: string; fires: readonly string[] }[]> {
  const app = doc.scope.level === "global" ? undefined : doc.scope.app;
  const loaded = await listFixtures(ctx, app);
  return loaded.map((f) => ({
    fixtureId: f.fixture.id,
    fires: doc.handlers.filter((h) => handlerFiresOn(h, doc.targets, doc.conditions, f)).map((h) => h.id),
  }));
}

/** One draft as plain lines for `pack draft show` (section 9 §8.5, section 5 §12.5): its class,
 * where it came from, the drafted detector and response, and each action's class. */
function draftLines(d: HandlerDraft): string[] {
  const h = d.handler;
  const lines = [
    `${d.app}/${d.id}: ${h.class}, from a ${d.source.kind} (run ${d.source.run_id}, seq ${d.source.seq.join(", ")})`,
    `scope: ${d.suggested_scope}, tenant ${d.source.tenant}, app version ${d.source.app_version}`,
    `detector: ${d.conditions.find((c) => c.id === h.detector)?.description ?? h.detector}`,
  ];
  if (h.class === "recoverable") {
    h.response.forEach((a, i) => lines.push(`response ${String(i + 1)}: ${a.type}${"target" in a ? ` ${a.target}` : ""} (${a.risk})`));
  }
  if (h.class === "needs_human") lines.push(`operator note: ${h.operator_note}`);
  for (const r of d.risk_hints) lines.push(`risk ${r.subject}: ${r.class} (${r.source})`);
  lines.push(`fire fixture: ${d.fixtures.fire}`);
  return lines;
}

/** Registers the pack commands. */
export const registerPack: Register = (program: Command, ctxOf) => {
  const pack = program.command("pack").description("handler packs: global, app, app_version, tenant scope");

  pack
    .command("edit")
    .argument("<scope>", "global, app:<app>, app_version:<app>:<pattern>, or tenant:<tenant>:<app>")
    .description("open $EDITOR on the scope's candidate, then validate it")
    .action(
      act(ctxOf, (ctx, args) => {
        const scope = scopeArg(args[0]);
        return editDoc(
          ctx,
          target(ctx, scope),
          (base) => nextRevision(scope, base),
          (doc) => checkLoader(ctx, doc),
          (doc, base, staff) => stampRiskDecisions(doc, base?.doc, staff, ctx.wiring.clock.now().toISOString()),
        );
      }),
    );

  pack
    .command("check")
    .argument("<scope>", "global, app:<app>, app_version:<app>:<pattern>, or tenant:<tenant>:<app>")
    .description("validate the candidate, or else the newest sealed revision; writes nothing")
    .action(
      act(ctxOf, async (ctx, args) => {
        const scope = scopeArg(args[0]);
        const t = target(ctx, scope);
        const got = await load(t, ["candidate", "approved", "sealed"]);
        if (!got) throw new CliExit(EXIT.usage, `${t.label} has no candidate or sealed revision`);
        const problems = await checkLoader(ctx, got.doc);
        if (problems.length > 0) throw new CliExit(EXIT.invalid, `${t.label} ${got.rev}:\n${problems.join("\n")}`);
        return answer(
          { document: t.label, rev: got.rev, state: got.state, valid: true },
          `${t.label} ${got.rev} (${got.state}) is valid.`,
        );
      }),
    );

  pack
    .command("seal")
    .argument("<scope>", "global, app:<app>, app_version:<app>:<pattern>, or tenant:<tenant>:<app>")
    .description("freeze the candidate as a sealed revision (reviewer)")
    .action(
      act(ctxOf, (ctx, args) => sealDoc(ctx, target(ctx, scopeArg(args[0])), (doc) => checkForSeal(ctx, doc))),
    );

  pack
    .command("approve")
    .argument("<scope>", "global, app:<app>, app_version:<app>:<pattern>, or tenant:<tenant>:<app>")
    .requiredOption("--rev <n>", "the sealed revision to approve")
    .description("stamp a sealed revision (approver, never its sealer); needs a passing regression batch for each approved key it touches")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const scope = scopeArg(args[0]);
        const rev = revOption(opts);
        // Why the role first: a person who cannot approve should hear that, not a list of keys.
        requireRole(ctx, scopeRole(scope), "approver");
        const t = target(ctx, scope);
        const sealed = await readSealed(t, rev);
        const layer: PackLayer = { scope, revision: sealed.doc.revision, pack: sealed.doc };
        const impact = await packImpact(scoreDeps(ctx), await driftTenants(ctx), layer, (tenant, app) => activeLayers(ctx, tenant, app));
        const missing = uncovered(impact);
        if (missing.length > 0) {
          throw new CliExit(
            EXIT.refused,
            [
              `${t.label} ${rev}: ${String(missing.length)} approved key(s) have no passing regression batch under the new handler set:`,
              ...missing.map((m) => `  ${m.key.tenant} ${m.text}${m.detail === undefined ? "" : ` (${m.detail})`}`),
              `Run: intyy certify --kind regression --pack ${packScopeText(scope)}@${rev} --all-affected  (once per tenant)`,
            ].join("\n"),
          );
        }
        return approveDoc(ctx, t, rev);
      }),
    );

  pack
    .command("impact")
    .argument("<scope>", "global, app:<app>, app_version:<app>:<pattern>, or tenant:<tenant>:<app>")
    .argument("<rev>", "the sealed revision, like 5")
    .description("lists the approved keys whose handler set hash would change; writes nothing")
    .action(
      act(ctxOf, async (ctx, args) => {
        const scope = scopeArg(args[0]);
        const got = await readCandidateLayer(ctx, `${packScopeText(scope)}@${args[1] ?? ""}`);
        const impact = await packImpact(scoreDeps(ctx), await driftTenants(ctx), got.layer, (tenant, app) => activeLayers(ctx, tenant, app));
        const text =
          impact.impacted.length === 0
            ? `${got.label}: no approved key is touched.`
            : impact.impacted
                .map((i) => `${i.key.tenant}  ${i.text}  ${i.before ?? "(none)"} -> ${i.after ?? "(invalid)"}${i.detail === undefined ? "" : `  ${i.detail}`}`)
                .join("\n");
        return answer(
          { pack: got.label, impacted: impact.impacted.map((i) => ({ tenant: i.key.tenant, key: i.text, before: i.before, after: i.after, ...(i.detail === undefined ? {} : { detail: i.detail }) })) },
          text,
        );
      }),
    );

  pack
    .command("dry-run")
    .argument("<scope>", "global, app:<app>, app_version:<app>:<pattern>, or tenant:<tenant>:<app>")
    .option("--fixtures", "run every saved fixture for the scope's app against it")
    .description("shows which detectors fire on which screens")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const scope = scopeArg(args[0]);
        const t = target(ctx, scope);
        const got = await load(t, ["candidate", "approved", "sealed"]);
        if (!got) throw new CliExit(EXIT.usage, `${t.label} has no candidate or sealed revision`);
        if (opts.fixtures !== true) {
          throw new CliExit(EXIT.usage, "dry-run: pass --fixtures (no --run support yet)");
        }
        const rows = await dryRunFixtures(ctx, got.doc);
        const lines = rows.map((r) => `${r.fixtureId}: ${r.fires.length > 0 ? r.fires.join(", ") : "(none)"}`);
        return answer({ document: t.label, rev: got.rev, fixtures: rows }, lines.join("\n"));
      }),
    );

  pack
    .command("second-look")
    .argument("<scope>", "global, app:<app>, app_version:<app>:<pattern>, or tenant:<tenant>:<app>")
    .argument("<subject>", "<handler_id>.response[<index>]")
    .option("--agree", "confirm the lowering")
    .option("--disagree", "record disagreement; the pack still cannot seal on this subject")
    .description("another reviewer's answer to a pack's lowered risk flag; never the staff who made it")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const scope = scopeArg(args[0]);
        const subject = args[1] ?? "";
        const staff = requireRole(ctx, scopeRole(scope), "reviewer");
        const agree = opts.agree === true;
        const disagree = opts.disagree === true;
        if (agree === disagree) throw new CliExit(EXIT.usage, "second-look: pass exactly one of --agree or --disagree");
        const t = target(ctx, scope);
        const cand = await load(t, ["candidate"]);
        if (!cand) throw new CliExit(EXIT.usage, `${t.label} has no candidate`);
        const risk = [...cand.doc.provenance.decisions].reverse().find((d) => d.what === "risk" && d.subject === subject);
        if (risk === undefined) throw new CliExit(EXIT.invalid, `${subject} has no risk decision yet; decide its risk first`);
        if (risk.by === staff) {
          throw new CliExit(EXIT.refused, `${staff} made that risk decision; another staff ID must give the second look`);
        }
        const decision: Decision = {
          what: "risk_second_look",
          subject,
          value: agree ? risk.value : "disputed",
          by: staff,
          at: ctx.wiring.clock.now().toISOString(),
        };
        const nextDoc: Pack = { ...cand.doc, provenance: { ...cand.doc.provenance, decisions: [...cand.doc.provenance.decisions, decision] } };
        orExit(await ctx.wiring.packs.putCandidate(t.id, nextDoc, requireStaff(ctx)), t.label);
        return answer(
          { document: t.label, subject, agreed: agree, by: staff },
          `${t.label} ${subject}: ${agree ? "agreed" : "disagreed"} by ${staff}.`,
        );
      }),
    );

  const draft = pack.command("draft").description("draft handlers from takeovers and discovery (section 5 §12)");

  draft
    .command("list")
    .option("--app <app>", "one app only")
    .description("lists draft handlers")
    .action(
      act(ctxOf, async (ctx, _args, opts) => {
        const refs = await ctx.wiring.drafts.list(typeof opts.app === "string" ? opts.app : undefined);
        const rows = [];
        for (const r of refs) {
          const got = orExit(await ctx.wiring.drafts.get(r.app, r.id), `draft ${r.app}/${r.id}`);
          rows.push({ app: r.app, id: r.id, source: got.source.kind, class: got.handler.class });
        }
        return answer(
          { drafts: rows },
          rows.length === 0 ? "no draft handlers" : rows.map((r) => `${r.app}/${r.id}  ${r.source}  ${r.class}`).join("\n"),
        );
      }),
    );

  draft
    .command("show")
    .argument("<id>", "the draft's ID")
    .option("--app <app>", "the draft's app, when two apps share an ID")
    .description("shows one draft handler")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const id = args[0] ?? "";
        const refs = (await ctx.wiring.drafts.list(typeof opts.app === "string" ? opts.app : undefined)).filter((r) => r.id === id);
        const ref = refs[0];
        if (ref === undefined) throw new CliExit(EXIT.usage, `no draft handler ${id}`);
        if (refs.length > 1) throw new CliExit(EXIT.usage, `draft ${id} exists in ${refs.map((r) => r.app).join(", ")}; pass --app`);
        const got = orExit(await ctx.wiring.drafts.get(ref.app, ref.id), `draft ${ref.app}/${ref.id}`);
        return answer(got, draftLines(got).join("\n"));
      }),
    );
};
