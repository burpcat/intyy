// `intyy artifact list | show | verify`: reading back sealed artifacts (section 9 §6.4, §11).
// This file owns argument parsing and printing only; the logic lives in
// `src/core/catalog/artifacts.ts`.
import type { Command } from "commander";
import { Semver } from "../../core/model/artifact/identity.js";
import { AppId } from "../../core/model/common.js";
import { CapabilityName } from "../../core/model/runspec.js";
import { listArtifacts, readArtifact, verifyArtifact } from "../../core/catalog/artifacts.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer } from "../output.js";
import { act, type Register } from "../program.js";
import { sealCheckContext } from "./candidate.js";
import { orExit } from "./documents.js";

/** One `<app>/<capability>@<version>` key, parsed. */
type ArtifactKey = { app: string; capability: string; version: string };

/** Parses `<app>/<capability>@<version>` (section 9 §7.2). `<version>` is a full semver: the
 * key `artifact show` and `artifact verify` take, unlike `capability describe`'s major-only key. */
function parseArtifactKey(arg: string | undefined): ArtifactKey {
  const m = /^([^/]+)\/([^@]+)@(.+)$/.exec(arg ?? "");
  const app = m?.[1];
  const capability = m?.[2];
  const version = m?.[3];
  if (
    app === undefined ||
    !AppId.safeParse(app).success ||
    capability === undefined ||
    !CapabilityName.safeParse(capability).success ||
    version === undefined ||
    !Semver.safeParse(version).success
  ) {
    throw new CliExit(
      EXIT.usage,
      `key ${arg ?? ""}: write <app>/<capability>@<version>, like kvfcu/sign_in@1.0.0`,
    );
  }
  return { app, capability, version };
}

/** Registers the artifact commands. */
export const registerArtifact: Register = (program: Command, ctxOf) => {
  const artifact = program.command("artifact").description("sealed artifact versions");

  artifact
    .command("list")
    .description("every sealed artifact, at its full version")
    .action(
      act(ctxOf, async (ctx) => {
        const rows = await listArtifacts(ctx.wiring.candidates);
        const lines = rows.map((r) => `${r.app}/${r.capability}@${r.version}`);
        return answer({ artifacts: rows }, lines.length === 0 ? "No sealed artifacts." : lines.join("\n"));
      }),
    );

  artifact
    .command("show")
    .argument("<key>", "app/capability@version")
    .description("one sealed artifact, in full")
    .action(
      act(ctxOf, async (ctx, args) => {
        const key = parseArtifactKey(args[0]);
        const doc = orExit(
          await readArtifact(ctx.wiring.candidates, key.app, key.capability, key.version),
          args[0] ?? "",
        );
        return answer({ artifact: doc }, JSON.stringify(doc, null, 2));
      }),
    );

  artifact
    .command("verify")
    .argument("<key>", "app/capability@version")
    .description(
      "re-reads and re-checks a sealed artifact: hash, the strict loader, and every crop; " +
        "exits non-zero on any problem",
    )
    .action(
      act(ctxOf, async (ctx, args) => {
        const key = parseArtifactKey(args[0]);
        const context = await sealCheckContext(ctx, key.app);
        const result = orExit(
          await verifyArtifact(ctx.wiring.candidates, key.app, key.capability, key.version, context),
          args[0] ?? "",
        );
        const lines = result.ok
          ? [`${args[0] ?? ""} is valid.`]
          : result.problems.map((p) => `${p.code}: ${p.message}`);
        return answer(
          { key: args[0], ok: result.ok, problems: result.problems },
          lines.join("\n"),
          result.ok ? EXIT.ok : EXIT.invalid,
        );
      }),
    );
};
