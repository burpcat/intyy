// The staff file `library/staff.json` (`intyy.staff/1.0`) and role checks.
// Follows design section 9 §7.7.
import { z } from "zod";
import { StaffId, TenantId } from "./common.js";

/** The three roles. */
export const Role = z.enum(["operator", "reviewer", "approver"]);

/** A role. */
export type Role = z.infer<typeof Role>;

/** Roles per tenant. `*` means every tenant. */
const Roles = z.record(z.union([z.literal("*"), TenantId]), z.array(Role).min(1));

/** The staff file. Changes go through git review, not the CLI. */
export const StaffFile = z
  .object({
    schema: z.literal("intyy.staff/1.0"),
    staff: z.array(z.object({ id: StaffId, roles: Roles }).strict()).min(1),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const s of file.staff) {
      if (seen.has(s.id))
        ctx.addIssue({ code: "custom", message: `staff ${s.id} is listed twice` });
      seen.add(s.id);
    }
  });

/** The staff file. */
export type StaffFile = z.infer<typeof StaffFile>;

/** One staff member. */
export type StaffMember = StaffFile["staff"][number];

/** Finds one staff member. */
export function findStaff(file: StaffFile, id: string): StaffMember | undefined {
  return file.staff.find((s) => s.id === id);
}

/**
 * True when `id` has `role` for `scope`. A tenant scope accepts the role on that tenant or on `*`.
 * The `*` scope is for shared documents: it needs the role on `*` itself (section 9 §7.7).
 */
export function hasRole(file: StaffFile, id: string, scope: string, role: Role): boolean {
  const member = findStaff(file, id);
  if (!member) return false;
  if (member.roles["*"]?.includes(role)) return true;
  return scope !== "*" && (member.roles[scope]?.includes(role) ?? false);
}

/**
 * Loader check: every tenant has at least one approver (section 9 §7.7). Checks each tenant the
 * file names, plus `tenants`, such as those with settings. Returns one line per problem.
 */
export function staffProblems(file: StaffFile, tenants: readonly string[] = []): string[] {
  const named = new Set(tenants);
  for (const s of file.staff) for (const t of Object.keys(s.roles)) if (t !== "*") named.add(t);
  const problems: string[] = [];
  if (!file.staff.some((s) => s.roles["*"]?.includes("approver")) && named.size === 0) {
    problems.push("no staff member is an approver");
  }
  for (const t of [...named].sort()) {
    if (!file.staff.some((s) => hasRole(file, s.id, t, "approver"))) {
      problems.push(`tenant ${t} has no approver`);
    }
  }
  return problems;
}
