// `intyy reconcile <run_id> --inputs <file>`: a human re-checks an uncertain commit by hand,
// after the run has already ended. Follows design section 9 §10.6 (manual reconcile),
// section 7 §11 (reconciliation runs); docs/decisions.md, M06.
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { resolveMajor } from "../../core/catalog/capabilities.js";
import { EffectUpdate } from "../../core/model/effect-update.js";
import { RunId } from "../../core/model/ids.js";
import { lookupRequestIndex } from "../../core/orchestrator/request-index.js";
import type { Request } from "../../core/model/request.js";
import { RunJson } from "../../core/model/run.js";
import { runReconciliationCheck } from "../../core/replay/reconciliation.js";
import { fact, maskedJson, Redactor, redactionRules } from "../../core/safety/redaction/redactor.js";
import type { RequestIndexKeySource } from "../../core/orchestrator/request-index.js";
import { requireRole, type Ctx } from "../context.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer, progress } from "../output.js";
import { act, readVersion, type Register } from "../program.js";
import { effectivePolicy } from "./policy.js";
import { settingsTarget } from "./settings.js";
import { load, orExit } from "./documents.js";

/** The run ID operand, checked. */
function runArg(args: string[]): string {
  const id = args[0] ?? "";
  if (!RunId.safeParse(id).success) throw new CliExit(EXIT.usage, `run ${id}: not a run ID`);
  return id;
}

/** Reads a file, or standard input for `-`. Never a flag value (docs/decisions.md, M04). */
async function readTextInput(ctx: Ctx, flag: string, path: string): Promise<string> {
  if (path === "-") return ctx.io.stdin.readAll();
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new CliExit(EXIT.usage, `${flag} ${path}: cannot be read`);
  }
}

/** Reads and parses one JSON file (or standard input) as the re-entered inputs. */
async function readInputsFile(ctx: Ctx, path: string): Promise<Record<string, string | number | boolean>> {
  const text = await readTextInput(ctx, "--inputs", path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliExit(EXIT.usage, `--inputs ${path}: not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliExit(EXIT.usage, `--inputs ${path}: must be a JSON object of input values`);
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw new CliExit(EXIT.usage, `--inputs ${path}: ${k} must be a string, number, or boolean`);
    }
    out[k] = v;
  }
  return out;
}

/** Walks `frozen`'s own nested shape (section 3 §6.5) by a dotted path. `run.json.frozen` is a
 * plain record (its shape follows what each run kind freezes), so this reads it defensively. */
function walk(frozen: Record<string, unknown>, path: readonly string[]): unknown {
  let cur: unknown = frozen;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Registers `reconcile`. */
export const registerReconcile: Register = (program: Command, ctxOf) => {
  program
    .command("reconcile")
    .argument("<run_id>", "the run whose commit is uncertain")
    .option("--inputs <file>", "the parent's own inputs, re-entered as JSON, from a file, or - for standard input")
    .description("re-check an uncertain commit by hand, after the run has ended (section 9 §10.6)")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const staff = requireRole(ctx, ctx.tenant, "operator");
        const parentRunId = runArg(args);
        if (typeof opts.inputs !== "string") {
          throw new CliExit(EXIT.usage, "name --inputs <file|->, the parent's own inputs as JSON");
        }
        const reentered = await readInputsFile(ctx, opts.inputs);

        const readRun = await ctx.wiring.evidence.readRunJson(ctx.tenant, parentRunId);
        if (!readRun.ok) throw new CliExit(EXIT.usage, `run ${parentRunId} is not in tenant ${ctx.tenant}`);
        const parsedRun = RunJson.safeParse(readRun.value);
        if (!parsedRun.success) throw new CliExit(EXIT.invalid, `run ${parentRunId}: run.json does not fit its schema`);
        const runJson = parsedRun.data;
        if (runJson.kind !== "replay" || runJson.result.status !== "failed" || runJson.result.effect?.commit !== "uncertain") {
          throw new CliExit(EXIT.usage, `run ${parentRunId} is not final with an uncertain commit`);
        }

        // The major link the caller used, rebuilt from the resolved version (section 3 §5.1):
        // the resolver always picks a version whose major matches what was asked for.
        const version = runJson.result.capability.version;
        if (version === null) throw new CliExit(EXIT.invalid, `run ${parentRunId}: no resolved capability version to reconcile against`);
        const capabilityLink = `${runJson.result.capability.name}@${version.split(".")[0] ?? ""}`;
        const [appName = ""] = runJson.result.capability.name.split("/");

        // Section 9 §10.6, step 2 and 3: check the re-entered inputs against the request
        // index's own keyed hash, while the entry exists; a mismatch refuses. No entry at all
        // (an absent request ID, or one past its expiry) warns and reads a note instead.
        const mode = walk(runJson.frozen, ["mode"]);
        const consentRef = walk(runJson.frozen, ["authorization", "consent_ref"]);
        const appVersion = walk(runJson.frozen, ["frozen", "app_version"]);
        const requestId = runJson.request_id;
        let note: string | null = null;
        const settingsDoc = await load(settingsTarget(ctx), ["approved"]);
        if (settingsDoc === undefined) throw new CliExit(EXIT.invalid, `settings ${ctx.tenant} have no approved revision`);
        const requestIndexKeys: RequestIndexKeySource[] = (settingsDoc.doc.system_secrets?.request_index_keys ?? []).map((k) => ({
          keyId: k.key_id,
          status: k.status,
          binding: { source: k.source, key: k.key },
        }));
        const requestIndexDeps = {
          store: ctx.wiring.requestIndexStore,
          clock: ctx.wiring.clock,
          secrets: ctx.wiring.secrets,
          keys: requestIndexKeys,
        };
        // Why the cast: `contentSubject` (and the lookup) only ever reads `capability`,
        // `inputs`, `mode`, and `authorization?.consent_ref` off this object; a manual
        // reconcile has no full `Authorization` block to rebuild, only the reference it hashed.
        const syntheticRequest = {
          schema: "intyy.request/1.0",
          request_id: requestId,
          capability: capabilityLink,
          inputs: reentered,
          mode: mode === "unattended" ? "unattended" : "supervised",
          ...(typeof consentRef === "string" ? { authorization: { consent_ref: consentRef } } : {}),
        } as unknown as Request;
        if (requestId === null) {
          progress(ctx.io, `run ${parentRunId}: no request ID was recorded; its inputs cannot be checked against anything.`);
          note = (await ctx.io.stdin.question("Enter a note for the record: ")).trim();
        } else {
          const looked = await lookupRequestIndex(requestIndexDeps, ctx.tenant, "reconcile", syntheticRequest);
          if (looked.ok && looked.value.status === "reused") {
            throw new CliExit(EXIT.refused, `run ${parentRunId}: the re-entered inputs do not match the original request`);
          }
          if (!looked.ok || looked.value.status === "new") {
            progress(ctx.io, `run ${parentRunId}: no matching, unexpired request-index entry; the re-entered inputs cannot be checked.`);
            note = (await ctx.io.stdin.question("Enter a note for the record: ")).trim();
          }
        }

        const policy = await effectivePolicy(ctx, appName);
        const sealed = orExit(await settingsTarget(ctx).store.get(settingsTarget(ctx).id, settingsDoc.rev), `settings ${ctx.tenant}`);
        const resolved = await resolveMajor(
          ctx.wiring.candidates,
          appName,
          runJson.result.capability.name.slice(appName.length + 1),
          Number(version.split(".")[0]),
          typeof appVersion === "string" ? appVersion : undefined,
        );
        if (!resolved.ok || resolved.value.recovery?.reconciliation?.check === undefined) {
          throw new CliExit(EXIT.usage, `run ${parentRunId}: this capability has no reconciliation check to run`);
        }
        const parentArtifact = resolved.value;
        const refs = new Map(Object.entries(reentered).map(([k, v]) => [`input.${k}`, String(v)]));

        const deps = {
          evidence: ctx.wiring.evidence,
          clock: ctx.wiring.clock,
          ids: ctx.wiring.ids,
          secrets: ctx.wiring.secrets,
          surface: ctx.wiring.discovery.surface(),
          artifacts: ctx.wiring.candidates,
          requestIndex: requestIndexDeps,
          operator: ctx.wiring.discovery.operator,
        };
        const parentInput = {
          runId: parentRunId,
          request: syntheticRequest,
          tenant: ctx.tenant,
          agentId: "reconcile",
          policy,
          settings: { doc: settingsDoc.doc, rev: settingsDoc.rev, hash: sealed.hash },
          appVersion: typeof appVersion === "string" ? appVersion : undefined,
          engineVersion: readVersion(),
          outputsRevealed: false,
          visible: false,
        };
        const { verdict, childRunId } = await runReconciliationCheck(parentInput, parentArtifact, refs, deps);

        let finding: "found_by_check" | "absent_by_check";
        if (verdict.kind === "found" || verdict.kind === "found_outputs_unavailable") {
          finding = "found_by_check";
        } else if (verdict.kind === "absent") {
          finding = "absent_by_check";
        } else {
          const line = await ctx.io.stdin.question(`run ${parentRunId}: what did the check show? [found/not_found] `);
          finding = /^f/i.test(line.trim()) ? "found_by_check" : "absent_by_check";
        }

        const r = new Redactor(redactionRules(policy.effective));
        const body = r.value({
          schema: "intyy.effect_update/1.0",
          parent_run_id: fact(parentRunId),
          check_run_id: childRunId === null ? null : fact(childRunId),
          finding,
          decided_by: verdict.kind === "unclear" ? "human" : "code",
          staff_id: staff,
          at: fact(ctx.wiring.clock.now().toISOString()),
        });
        EffectUpdate.parse(body);
        const folder = await ctx.wiring.evidence.openRun(ctx.tenant, parentRunId);
        if (!folder.ok) throw new CliExit(EXIT.usage, `run ${parentRunId}: its folder could not be opened`);
        const written = await folder.value.writeFile("effect_update.json", maskedJson(body));
        if (!written.ok) throw new CliExit(EXIT.invalid, `run ${parentRunId}: effect_update.json could not be written`);
        await ctx.wiring.evidence.appendIndex(
          ctx.tenant,
          r.value({
            run_id: fact(parentRunId),
            at: fact(ctx.wiring.clock.now().toISOString()),
            status: "failed",
            code: "effect_updated",
            kind: "replay",
            capability: runJson.result.capability.name,
          }),
        );
        if (note !== null && note !== "") progress(ctx.io, `note recorded: ${note}`);

        return answer(
          { run_id: parentRunId, finding, check_run_id: childRunId },
          `run ${parentRunId}: manual reconcile found ${finding}${childRunId === null ? "" : ` (check run ${childRunId})`}.`,
        );
      }),
    );
};
