// `intyy capability list | describe`: which capabilities a tenant can call, and how (section 9
// §11). This file owns argument parsing, `--format`, and printing only; the logic lives in
// `src/core/catalog/capabilities.ts`.
import type { Command } from "commander";
import { AppId } from "../../core/model/common.js";
import { CapabilityName } from "../../core/model/runspec.js";
import { listCapabilities, resolveMajor, toolDefinition } from "../../core/catalog/capabilities.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer } from "../output.js";
import { act, type Register } from "../program.js";
import { orExit } from "./documents.js";

/** One `<app>/<capability>@<major>` key, parsed (section 9 §7.2: "a caller's name: the major only"). */
type CapabilityKey = { app: string; capability: string; major: number };

/** Parses `<app>/<capability>@<major>`. */
function parseCapabilityKey(arg: string | undefined): CapabilityKey {
  const m = /^([^/]+)\/([^@]+)@(\d+)$/.exec(arg ?? "");
  const app = m?.[1];
  const capability = m?.[2];
  const majorText = m?.[3];
  if (
    app === undefined ||
    !AppId.safeParse(app).success ||
    capability === undefined ||
    !CapabilityName.safeParse(capability).success ||
    majorText === undefined
  ) {
    throw new CliExit(EXIT.usage, `key ${arg ?? ""}: write <app>/<capability>@<major>, like kvfcu/sign_in@1`);
  }
  return { app, capability, major: Number(majorText) };
}

/** Registers the capability commands. */
export const registerCapability: Register = (program: Command, ctxOf) => {
  const capability = program.command("capability").description("capabilities a tenant can call");

  capability
    .command("list")
    .description("every sealed capability, at its major version")
    .action(
      act(ctxOf, async (ctx) => {
        const rows = orExit(await listCapabilities(ctx.wiring.candidates), "capability list");
        const lines = rows.map(
          (r) => `${r.app}/${r.capability}@${String(r.major)}  ${r.effect}  ${r.state}`,
        );
        return answer(
          { capabilities: rows },
          lines.length === 0 ? "No sealed capabilities." : lines.join("\n"),
        );
      }),
    );

  capability
    .command("describe")
    .argument("<key>", "app/capability@major")
    .option("--format <kind>", "tool: prints {name, description, input_schema} for an agent")
    .description("about, inputs and outputs, outcomes, effect, and caller rules")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        const key = parseCapabilityKey(args[0]);
        const artifact = orExit(
          await resolveMajor(ctx.wiring.candidates, key.app, key.capability, key.major),
          args[0] ?? "",
        );
        if (opts.format !== undefined && opts.format !== "tool") {
          throw new CliExit(EXIT.usage, "--format takes one value: tool");
        }
        if (opts.format === "tool") {
          const tool = toolDefinition(artifact, key.major);
          return answer(tool, JSON.stringify(tool, null, 2));
        }
        const lines = [
          `${key.app}/${key.capability}@${String(key.major)}  ${artifact.contract.effect}  draft`,
          artifact.about.summary,
          `inputs: ${artifact.contract.inputs.map((i) => i.name).join(", ") || "none"}`,
          `outputs: ${artifact.contract.outputs.map((o) => o.name).join(", ") || "none"}`,
          `outcomes: ${artifact.contract.outcomes.map((o) => o.code).join(", ") || "none"}`,
        ];
        return answer({ capability: key, artifact }, lines.join("\n"));
      }),
    );
};
