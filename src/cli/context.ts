// What every command knows: its data root, config, tenant, staff ID, flags, and ports.
// Follows design section 9 §6.1 (root lookup), §7.3 (global flags), and §7.7 (identity and roles).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { z } from "zod";
import { StaffId, TenantId } from "../core/model/common.js";
import { Config } from "../core/model/config.js";
import { issueText } from "../core/model/sealing.js";
import { hasRole, StaffFile, type Role } from "../core/model/staff.js";
import type { LockHold, LockKind, LockRequest } from "../ports/locks.js";
import { loadDotEnv } from "./env.js";
import { CliExit, EXIT } from "./exit-codes.js";
import type { Io, PrintOptions } from "./output.js";
import type { Wiring } from "./wiring.js";

/** The global flags of section 9 §7.3, after parsing. */
export type GlobalFlags = {
  root: string | undefined;
  tenant: string | undefined;
  staff: string | undefined;
  json: boolean;
  revealOutputs: boolean;
  models: string | undefined;
};

/** Everything a command runs with. */
export type Ctx = {
  io: Io;
  root: string;
  config: Config;
  tenant: string;
  /** From `--staff` or `INTYY_STAFF`. Null when neither is set. */
  staff: string | null;
  flags: GlobalFlags;
  wiring: Wiring;
};

/** The root marker file. */
export const ROOT_FILE = "intyy.json";

/** Finds the data root: `--root`, or the nearest folder upwards holding `intyy.json`. */
export function findRoot(cwd: string, override: string | undefined): string {
  if (override !== undefined) {
    const root = resolve(cwd, override);
    if (!existsSync(join(root, ROOT_FILE))) {
      throw new CliExit(EXIT.usage, `--root ${override} holds no ${ROOT_FILE}`);
    }
    return root;
  }
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ROOT_FILE))) return dir;
    if (dirname(dir) === dir) {
      throw new CliExit(EXIT.usage, `no ${ROOT_FILE} here or above; pass --root`);
    }
  }
}

/** Reads and checks one JSON file with `schema`. A missing or bad file exits 7. */
export function readChecked<T>(path: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    const why = e instanceof SyntaxError ? "is not valid JSON" : "cannot be read";
    throw new CliExit(EXIT.invalid, `${path} ${why}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CliExit(EXIT.invalid, `${path}: ${issueText(parsed.error)}`);
  return parsed.data;
}

/** Checks a flag's value against a schema. A bad value is a usage error that names the flag. */
function flagValue(flag: string, value: string, schema: z.ZodType<string>): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new CliExit(EXIT.usage, `${flag} ${value}: ${issueText(parsed.error)}`);
  return parsed.data;
}

/**
 * Builds the context. Order matters: the `.env` loader runs before `INTYY_STAFF` is read, so a
 * staff ID in `.env` counts, and a shell variable still wins over it.
 */
export function makeContext(
  io: Io,
  flags: GlobalFlags,
  wire: (root: string, config: Config, env: Record<string, string | undefined>) => Wiring,
): Ctx {
  const root = findRoot(io.cwd, flags.root);
  loadDotEnv(root, io.env);
  const config = readChecked(join(root, ROOT_FILE), Config);
  const tenant = flagValue("--tenant", flags.tenant ?? config.default_tenant, TenantId);
  const rawStaff = flags.staff ?? io.env.INTYY_STAFF;
  const staff =
    rawStaff === undefined || rawStaff === "" ? null : flagValue("--staff", rawStaff, StaffId);
  return { io, root, config, tenant, staff, flags, wiring: wire(root, config, io.env) };
}

/** How this command prints. */
export function printOptions(ctx: Pick<Ctx, "flags">): PrintOptions {
  return { json: ctx.flags.json, reveal: ctx.flags.revealOutputs };
}

/** Reads the staff file (section 9 §7.7). Missing or invalid exits 7. */
export function readStaff(ctx: Ctx): StaffFile {
  return readChecked(join(ctx.root, ctx.config.library, "staff.json"), StaffFile);
}

/** The staff ID, or a usage error naming the flag (section 9 §7.6). */
export function requireStaff(ctx: Ctx): string {
  if (ctx.staff === null)
    throw new CliExit(EXIT.usage, "no staff ID: pass --staff or set INTYY_STAFF");
  return ctx.staff;
}

/**
 * Checks the staff ID holds `role` for `scope`: a tenant, or `*` for shared documents.
 * Refuses with exit 6 when it does not (section 9 §7.5, refused by a rule: role).
 */
export function requireRole(ctx: Ctx, scope: string, role: Role): string {
  const staff = requireStaff(ctx);
  const file = readStaff(ctx);
  if (!file.staff.some((s) => s.id === staff)) {
    throw new CliExit(EXIT.refused, `role: ${staff} is not in staff.json`);
  }
  if (!hasRole(file, staff, scope, role)) {
    const where = scope === "*" ? "every tenant (*)" : `tenant ${scope}`;
    throw new CliExit(EXIT.refused, `role: ${staff} lacks the ${role} role for ${where}`);
  }
  return staff;
}

/**
 * Takes a lock, or ends the command with exit 8. Standard error names the holder: command,
 * staff ID, and start time (section 9 §12.2). No run exists yet, so nothing else is written.
 */
export async function takeLock(
  ctx: Ctx,
  kind: LockKind,
  key: string,
  req: LockRequest,
): Promise<LockHold> {
  const got = await ctx.wiring.locks.acquire(kind, key, req);
  if (!got.ok)
    throw new CliExit(EXIT.busy, `busy: the ${kind} lock ${key} is ${got.detail ?? "held"}`);
  return got.value;
}
