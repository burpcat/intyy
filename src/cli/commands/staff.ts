// `intyy staff whoami | check`: identity from the staff file.
// Follows design section 9 §7.7. The staff file changes through git review, not the CLI.
import type { Command } from "commander";
import { staffProblems } from "../../core/model/staff.js";
import { readStaff, requireStaff } from "../context.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer } from "../output.js";
import { act, type Register } from "../program.js";

/** Registers the staff commands. */
export const registerStaff: Register = (program: Command, ctxOf) => {
  const staff = program.command("staff").description("who is who: the staff file");

  staff
    .command("whoami")
    .description("print the staff ID this command runs as, and its roles")
    .action(
      act(ctxOf, (ctx) => {
        const id = requireStaff(ctx);
        const member = readStaff(ctx).staff.find((s) => s.id === id);
        if (!member) throw new CliExit(EXIT.refused, `role: ${id} is not in staff.json`);
        const lines = Object.entries(member.roles).map(
          ([tenant, roles]) => `  ${tenant}: ${roles.join(", ")}`,
        );
        return Promise.resolve(answer({ id, roles: member.roles }, [id, ...lines].join("\n")));
      }),
    );

  staff
    .command("check")
    .description("validate the staff file: schema, and an approver for every tenant")
    .action(
      act(ctxOf, async (ctx) => {
        const file = readStaff(ctx);
        const tenants = (await ctx.wiring.settings.list({})).map((s) => s.id);
        const problems = staffProblems(file, tenants);
        if (problems.length > 0)
          throw new CliExit(EXIT.invalid, `staff.json:\n${problems.join("\n")}`);
        return answer(
          { valid: true, staff: file.staff.map((s) => s.id) },
          `staff.json is valid: ${String(file.staff.length)} staff, and every tenant has an approver.`,
        );
      }),
    );
};
