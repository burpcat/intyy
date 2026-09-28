// Shared steps for sealed documents: find a revision, edit a candidate, seal, and approve.
// Follows design section 9 §7.1 (verbs mean the same on every noun), §6.4 (four eyes), §2.6.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DocKind } from "../../core/model/sealing.js";
import { issueText } from "../../core/model/sealing.js";
import type { Outcome } from "../../ports/outcome.js";
import type { DocState, DocumentStore } from "../../ports/stores.js";
import { readStaff, requireRole, requireStaff, type Ctx } from "../context.js";
import { CliExit, EXIT, exitForFailure } from "../exit-codes.js";
import { answer, progress, type Answer } from "../output.js";

/** One document in one store. Example: the keystone tenant policy layer. */
export type DocTarget<T> = {
  store: DocumentStore<T>;
  kind: DocKind<T>;
  /** The store ID. Example: `tenant/keystone`. */
  id: string;
  /** How output names it. Example: `policy tenant:keystone`. */
  label: string;
  /** Who may seal and approve: a tenant, or `*` for shared documents (section 9 §7.7). */
  scope: string;
};

/** One revision of a document, with where it came from. */
export type Loaded<T> = { doc: T; rev: string; state: DocState };

/** Ends the command on a failed outcome, with the exit code its failure name maps to. */
export function orExit<T, F extends string>(o: Outcome<T, F>, what: string): T {
  if (o.ok) return o.value;
  throw new CliExit(exitForFailure(o.failure), `${what}: ${o.detail ?? o.failure}`);
}

/** The newest revision in one of `states`, or undefined. */
export async function newest<T>(
  t: DocTarget<T>,
  states: readonly DocState[],
): Promise<string | undefined> {
  const all = await t.store.list({ id: t.id });
  return all.filter((s) => states.includes(s.state)).at(-1)?.rev;
}

/** Reads a sealed revision; the store checks its hash. A changed file exits 7. */
export async function readSealed<T>(t: DocTarget<T>, rev: string): Promise<Loaded<T>> {
  const got = orExit(await t.store.get(t.id, rev), `${t.label} ${rev}`);
  return { doc: got.doc, rev, state: got.approved ? "approved" : "sealed" };
}

/**
 * The revision a command works on, best first: `prefer` lists the states to try in order.
 * Example: `check` tries the candidate, then the newest approved, then the newest sealed.
 */
export async function load<T>(
  t: DocTarget<T>,
  prefer: readonly DocState[],
): Promise<Loaded<T> | undefined> {
  for (const state of prefer) {
    if (state === "candidate") {
      const c = await t.store.getCandidate(t.id);
      if (c.ok) return { doc: c.value.doc, rev: c.value.rev, state };
      if (c.failure === "invalid")
        throw new CliExit(EXIT.invalid, `${t.label} candidate: ${c.detail ?? ""}`);
      continue;
    }
    const rev = await newest(t, [state]);
    if (rev !== undefined) return readSealed(t, rev);
  }
  return undefined;
}

/** Checks the staff ID is in the staff file. Any role may write a candidate. */
function requireKnownStaff(ctx: Ctx): string {
  const staff = requireStaff(ctx);
  if (!readStaff(ctx).staff.some((s) => s.id === staff)) {
    throw new CliExit(EXIT.refused, `role: ${staff} is not in staff.json`);
  }
  return staff;
}

/** Opens `$VISUAL` or `$EDITOR` on a file and waits for it to close. */
export function runEditor(ctx: Ctx, path: string): void {
  const editor = ctx.io.env.VISUAL ?? ctx.io.env.EDITOR;
  if (editor === undefined || editor === "") {
    throw new CliExit(EXIT.usage, "set EDITOR to edit a candidate");
  }
  // Why a shell: EDITOR may carry its own flags, like "code --wait".
  const done = spawnSync(`${editor} "${path}"`, {
    shell: true,
    stdio: "inherit",
    env: { ...ctx.io.env },
  });
  if (done.status !== 0)
    throw new CliExit(EXIT.usage, `the editor exited with ${String(done.status)}`);
}

/**
 * Edits the candidate: opens `$EDITOR` on a copy, then validates before it writes (section 9
 * §7.1). A bad edit is not saved; its file stays in `state/var/tmp` so no work is lost.
 */
export async function editDoc<T>(
  ctx: Ctx,
  t: DocTarget<T>,
  start: (base: Loaded<T> | undefined) => unknown,
  validate: (doc: T) => Promise<string[]>,
): Promise<Answer> {
  const staff = requireKnownStaff(ctx);
  const base = await load(t, ["candidate", "approved", "sealed"]);
  const first = base?.state === "candidate" ? base.doc : start(base);
  mkdirSync(ctx.wiring.tmpDir, { recursive: true });
  const path = join(ctx.wiring.tmpDir, `edit-${t.id.replaceAll("/", "-")}-${randomUUID()}.json`);
  writeFileSync(path, `${JSON.stringify(first, null, 2)}\n`);
  runEditor(ctx, path);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliExit(
      EXIT.invalid,
      `${t.label}: the edit is not valid JSON. It is kept at ${path}`,
    );
  }
  const parsed = t.kind.parse(raw);
  if (!parsed.success) {
    throw new CliExit(
      EXIT.invalid,
      `${t.label}: ${issueText(parsed.error)}. The edit is kept at ${path}`,
    );
  }
  const problems = await validate(parsed.data);
  if (problems.length > 0) {
    throw new CliExit(
      EXIT.invalid,
      `${t.label}:\n${problems.join("\n")}\nThe edit is kept at ${path}`,
    );
  }
  orExit(await t.store.putCandidate(t.id, parsed.data, staff), `${t.label} candidate`);
  rmSync(path, { force: true });
  const rev = t.kind.revOf(parsed.data);
  return answer(
    { document: t.label, rev, state: "candidate" },
    `${t.label} candidate ${rev} saved.`,
  );
}

/** Seals the candidate. Reviewer role; the candidate must pass its checks first. */
export async function sealDoc<T>(
  ctx: Ctx,
  t: DocTarget<T>,
  validate: (doc: T) => Promise<string[]>,
): Promise<Answer> {
  const staff = requireRole(ctx, t.scope, "reviewer");
  const cand = await load(t, ["candidate"]);
  if (!cand) throw new CliExit(EXIT.usage, `${t.label} has no candidate to seal`);
  const problems = await validate(cand.doc);
  if (problems.length > 0)
    throw new CliExit(EXIT.invalid, `${t.label} ${cand.rev}:\n${problems.join("\n")}`);
  const sealed = orExit(await t.store.seal(t.id, staff), `${t.label} seal`);
  return answer(
    { document: t.label, rev: sealed.rev, hash: sealed.hash, sealed_by: staff },
    `${t.label} ${sealed.rev} sealed by ${staff}.\nhash ${sealed.hash}`,
  );
}

/** Approves a sealed revision. Approver role, and never the sealer (four eyes, section 9 §6.4). */
export async function approveDoc<T>(ctx: Ctx, t: DocTarget<T>, rev: string): Promise<Answer> {
  const staff = requireRole(ctx, t.scope, "approver");
  const done = await t.store.approve(t.id, rev, staff);
  if (!done.ok && done.failure === "rule" && done.detail === "four_eyes") {
    throw new CliExit(
      EXIT.refused,
      `four eyes: ${staff} sealed ${t.label} ${rev}; another approver must approve it`,
    );
  }
  if (!done.ok && done.failure === "rule" && done.detail === "already_approved") {
    throw new CliExit(EXIT.refused, `${t.label} ${rev} is already approved`);
  }
  orExit(done, `${t.label} ${rev}`);
  progress(ctx.io, `${t.label} ${rev} is approved. It applies from the next run.`);
  return answer(
    { document: t.label, rev, approved_by: staff },
    `${t.label} ${rev} approved by ${staff}.`,
  );
}

/** Reads a required `--rev` option as a positive whole number. */
export function revOption(opts: Record<string, unknown>): string {
  const rev = opts.rev;
  if (typeof rev !== "string" || !/^[1-9]\d*$/.test(rev)) {
    throw new CliExit(EXIT.usage, "--rev takes a revision number, like --rev 1");
  }
  return rev;
}
