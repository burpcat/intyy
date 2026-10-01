// `intyy tags report <app>`: tag agreement per discovery model, prompt version, and tag type,
// read from the sealed artifacts of one app. Follows design section 9 §9.5 and section 8 §14.3.
import type { Command } from "commander";
import { listArtifacts, readArtifact } from "../../core/catalog/artifacts.js";
import { actionsOf, tagTable, type TaggedAction } from "../../core/certify/tag-agreement.js";
import { AppId } from "../../core/model/common.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer } from "../output.js";
import { act, type Register } from "../program.js";

/** Registers `tags report`. */
export const registerTags: Register = (program: Command, ctxOf) => {
  const tags = program.command("tags").description("discovery tag agreement");

  tags
    .command("report")
    .argument("<app>", "the app ID")
    .description("tag agreement per model, prompt version, and tag type; grants nothing")
    .action(
      act(ctxOf, async (ctx, args) => {
        const parsed = AppId.safeParse(args[0] ?? "");
        if (!parsed.success) throw new CliExit(EXIT.usage, "app: write a lower-case app ID, like kvfcu");
        const app = parsed.data;
        const actions: TaggedAction[] = [];
        let artifacts = 0;
        for (const a of await listArtifacts(ctx.wiring.candidates)) {
          if (a.app !== app) continue;
          const read = await readArtifact(ctx.wiring.candidates, a.app, a.capability, a.version);
          if (!read.ok) throw new CliExit(EXIT.invalid, `${a.app}/${a.capability}@${a.version}: ${read.detail ?? read.failure}`);
          artifacts += 1;
          actions.push(...actionsOf(read.value));
        }
        const rows = tagTable(actions);
        const header = "model            prompt        tag_type     reviewed  agreed  agreement  recent_changes  ready";
        const lines = rows.map(
          (r) =>
            `${r.model.padEnd(16)} ${(r.prompt ?? "unrecorded").padEnd(13)} ${r.tag_type.padEnd(12)} ${String(r.reviewed).padStart(8)}  ${String(r.agreed).padStart(6)}  ${(r.agreement === null ? "-" : r.agreement.toFixed(3)).padStart(9)}  ${String(r.recent_changes).padStart(14)}  ${r.ready ? "yes" : "no"}`,
        );
        return answer(
          { app, artifacts, rows },
          [`tag agreement for ${app}: ${String(artifacts)} sealed artifact(s)`, header, ...lines].join("\n"),
        );
      }),
    );
};
