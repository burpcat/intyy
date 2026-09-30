// `intyy fixture new | list | show`: saved, masked screens a pack's detectors run against.
// Follows design section 9 §8.5 and section 5 §13.1. Section 9 §8.5 writes the run and its
// observation together as `--from <run_id> <seq>`; a command option cannot hold two values, so
// this splits it into `--run <run_id> --seq <n>`. `fixture new` also takes the fixture ID and
// `--app` explicitly: the design's abbreviated command row names neither, but every other
// intyy command names its ID and its app explicitly, and a fixture folder sits at
// `library/fixtures/<app>/<fixture_id>/` (section 9 §6.2), so nothing else can supply them.
// `--variant` is new: the bank app's branding variant (`KVFCU_VARIANT`, `CONTRACT.md`) is not
// recorded anywhere else in this build, so this is the one place it must be typed in by hand.
import type { Command } from "commander";
import { FixtureKind, type Fixture } from "../../core/model/fixture.js";
import { SnakeId } from "../../core/model/artifact/shared.js";
import type { Ctx } from "../context.js";
import { requireRole } from "../context.js";
import { CliExit, EXIT } from "../exit-codes.js";
import { answer } from "../output.js";
import { act, type Register } from "../program.js";
import { load } from "./documents.js";
import { listFixtures, readFixture, readFixtureKind, writeFixtureFile, writeFixtureMeta } from "./fixtures-fs.js";
import { settingsTarget } from "./settings.js";

/** One run's observation event at log line `seq` (section 3 §7.1's `events.jsonl` shape). */
type ObservationLine = { seq: number; event: string; data: { location: string; files: readonly string[] } };

function isObservationLine(line: unknown): line is ObservationLine {
  if (line === null || typeof line !== "object") return false;
  const l = line as Record<string, unknown>;
  return (
    typeof l.seq === "number" &&
    l.event === "observation" &&
    l.data !== null &&
    typeof l.data === "object" &&
    typeof (l.data as Record<string, unknown>).location === "string"
  );
}

/** Reads one run's observation line at `seq`, and its saved capture files' bytes. */
async function readCapture(
  ctx: Ctx,
  tenant: string,
  runId: string,
  seq: number,
): Promise<{ location: string; a11y: string; dom: string | undefined; screen: Uint8Array | undefined }> {
  const events = await ctx.wiring.evidence.events(tenant, runId);
  if (!events.ok) throw new CliExit(EXIT.usage, `run ${runId}: ${events.detail ?? events.failure}`);
  const line = events.value.find((l) => isObservationLine(l) && l.seq === seq);
  if (line === undefined || !isObservationLine(line)) {
    throw new CliExit(EXIT.usage, `run ${runId} has no observation at seq ${String(seq)}`);
  }
  const folder = await ctx.wiring.evidence.openRun(tenant, runId);
  if (!folder.ok) throw new CliExit(EXIT.usage, `run ${runId}: ${folder.detail ?? folder.failure}`);
  const a11yPath = line.data.files.find((f) => f.startsWith("a11y/"));
  const domPath = line.data.files.find((f) => f.startsWith("dom/"));
  const screenPath = line.data.files.find((f) => f.startsWith("screens/"));
  const a11y = a11yPath === undefined ? undefined : await folder.value.readFile(a11yPath);
  const dom = domPath === undefined ? undefined : await folder.value.readFile(domPath);
  const screen = screenPath === undefined ? undefined : await folder.value.readFile(screenPath);
  return {
    location: line.data.location,
    a11y: a11y?.ok === true ? new TextDecoder().decode(a11y.value) : "",
    dom: dom?.ok === true ? new TextDecoder().decode(dom.value) : undefined,
    screen: screen?.ok === true ? screen.value : undefined,
  };
}

/** Registers the fixture commands. */
export const registerFixture: Register = (program: Command, ctxOf) => {
  const fixture = program.command("fixture").description("saved, masked screens (section 5 §13.1)");

  fixture
    .command("new")
    .argument("<id>", "the fixture ID, shared across every pack (section 5 §13.1)")
    .requiredOption("--app <app>", "the fixture's app")
    .requiredOption("--variant <variant>", "the bank app's branding variant, like keystone or lakeshore")
    .requiredOption("--run <run_id>", "the run to capture from")
    .requiredOption("--seq <n>", "the run log line's seq, at its observation event")
    .option("--kind <kind>", "trouble or normal (a fresh capture only)")
    .option("--upgrade", "rebuild an existing fixture's meta.json from --run/--seq, keeping its files")
    .description("saves a masked screen as a fixture, or rebuilds an old one's meta.json")
    .action(
      act(ctxOf, async (ctx, args, opts) => {
        requireRole(ctx, "*", "reviewer");
        const id = SnakeId.parse(args[0]);
        const app = String(opts.app);
        const variant = String(opts.variant);
        const runId = String(opts.run);
        const seq = Number(opts.seq);
        if (!Number.isInteger(seq)) throw new CliExit(EXIT.usage, "fixture new: --seq takes a whole number");
        const captured = await readCapture(ctx, ctx.tenant, runId, seq);
        const settings = await load(settingsTarget(ctx), ["approved", "sealed"]);
        const appVersion = settings?.doc.apps[app]?.app_version;
        if (appVersion === undefined) {
          throw new CliExit(EXIT.usage, `fixture new: no app_version for ${app} in ${ctx.tenant}'s settings`);
        }
        let kind: "trouble" | "normal";
        if (opts.upgrade === true) {
          kind = await readFixtureKind(ctx, app, id);
        } else {
          const parsedKind = FixtureKind.safeParse(opts.kind);
          if (!parsedKind.success) throw new CliExit(EXIT.usage, "fixture new: pass --kind trouble or normal");
          kind = parsedKind.data;
          await writeFixtureFile(ctx, app, id, "a11y.yaml", captured.a11y);
          if (captured.dom !== undefined) await writeFixtureFile(ctx, app, id, "dom.html", captured.dom);
          if (captured.screen !== undefined) await writeFixtureFile(ctx, app, id, "screen.png", captured.screen);
        }
        const missing = (["a11y.yaml", "dom.html", "screen.png"] as const).filter(
          (name) =>
            (name === "a11y.yaml" && captured.a11y === "") ||
            (name === "dom.html" && captured.dom === undefined) ||
            (name === "screen.png" && captured.screen === undefined),
        );
        const meta: Fixture = {
          schema: "intyy.fixture/1.0",
          id,
          app,
          tenant: ctx.tenant,
          app_version: appVersion,
          variant,
          location: captured.location,
          viewport: { width: 1280, height: 800 },
          source: { run_id: runId, seq },
          kind,
          ...(missing.length > 0 ? { missing } : {}),
        };
        await writeFixtureMeta(ctx, meta);
        return answer(
          { fixture: `${app}/${id}`, ...meta },
          `fixture ${app}/${id} ${opts.upgrade === true ? "upgraded" : "saved"} from ${runId}#${String(seq)}.`,
        );
      }),
    );

  fixture
    .command("list")
    .option("--app <app>", "one app only")
    .description("lists saved fixtures")
    .action(
      act(ctxOf, async (ctx, _args, opts) => {
        const loaded = await listFixtures(ctx, typeof opts.app === "string" ? opts.app : undefined);
        const rows = loaded.map((f) => ({ id: f.fixture.id, app: f.fixture.app, kind: f.fixture.kind, location: f.fixture.location }));
        return answer({ fixtures: rows }, rows.map((r) => `${r.app}/${r.id}: ${r.kind} at ${r.location}`).join("\n"));
      }),
    );

  fixture
    .command("show")
    .argument("<app>", "the fixture's app")
    .argument("<id>", "the fixture ID")
    .description("prints one fixture's meta.json")
    .action(
      act(ctxOf, async (ctx, args) => {
        const loaded = await readFixture(ctx, args[0] ?? "", args[1] ?? "");
        return answer(loaded.fixture, JSON.stringify(loaded.fixture, null, 2));
      }),
    );
};
