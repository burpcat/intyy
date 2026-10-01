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

/** One run log line's data, when it is an object (section 3 §7.1's `events.jsonl` shape). */
function dataOf(line: unknown): Record<string, unknown> | null {
  if (line === null || typeof line !== "object") return null;
  const d = (line as Record<string, unknown>).data;
  return d !== null && typeof d === "object" ? (d as Record<string, unknown>) : null;
}

/** The capture files a log line names: a discovery `observation`, or a replay `ladder` or failure
 * capture (section 3 §7.5). Empty when the line names none. */
function filesOf(line: unknown): string[] {
  const files = dataOf(line)?.files;
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
}

/** A logged capture path as it is on disk. Why: runs logged before ladder paths were facts have
 * the run-log number masked (`a11y/[digits#1]_x_ladder.yaml`); the one file in `run.json` with the
 * same folder and name after the number is it. `undefined` when none or more than one fits. */
function onDisk(path: string, runFiles: readonly string[]): string | undefined {
  const m = /^([a-z0-9]+\/)\[[a-z]+#\d+\](_.+)$/.exec(path);
  if (m === null) return path;
  const fits = runFiles.filter((f) => f.startsWith(m[1] ?? "") && f.endsWith(m[2] ?? "") && /^[a-z0-9]+\/\d+_/.test(f));
  return fits.length === 1 ? fits[0] : undefined;
}

/** Reads one run's capture line at `seq`, and its saved capture files' bytes. A replay capture
 * line names no location, so the last one the log names before it stands in. */
async function readCapture(
  ctx: Ctx,
  tenant: string,
  runId: string,
  seq: number,
): Promise<{ location: string; a11y: string; dom: string | undefined; screen: Uint8Array | undefined }> {
  const events = await ctx.wiring.evidence.events(tenant, runId);
  if (!events.ok) throw new CliExit(EXIT.usage, `run ${runId}: ${events.detail ?? events.failure}`);
  const at = events.value.findIndex((l) => (l as { seq?: unknown } | null)?.seq === seq);
  const line = events.value[at];
  if (at < 0 || !filesOf(line).some((f) => f.startsWith("a11y/"))) {
    throw new CliExit(EXIT.usage, `run ${runId} has no capture at seq ${String(seq)}`);
  }
  let location = "";
  for (let i = at; i >= 0 && location === ""; i--) {
    const d = dataOf(events.value[i]);
    const loc = d?.location ?? d?.path;
    if (typeof loc === "string" && loc.startsWith("/")) location = loc;
  }
  const folder = await ctx.wiring.evidence.openRun(tenant, runId);
  if (!folder.ok) throw new CliExit(EXIT.usage, `run ${runId}: ${folder.detail ?? folder.failure}`);
  const runJson = await ctx.wiring.evidence.readRunJson(tenant, runId);
  const listed = runJson.ok ? (runJson.value as { files?: { path?: unknown }[] }).files : undefined;
  const runFiles = (listed ?? []).map((f) => f.path).filter((p): p is string => typeof p === "string");
  const files = filesOf(line).map((f) => onDisk(f, runFiles)).filter((f): f is string => f !== undefined);
  const a11yPath = files.find((f) => f.startsWith("a11y/"));
  const domPath = files.find((f) => f.startsWith("dom/"));
  const screenPath = files.find((f) => f.startsWith("screens/"));
  const a11y = a11yPath === undefined ? undefined : await folder.value.readFile(a11yPath);
  const dom = domPath === undefined ? undefined : await folder.value.readFile(domPath);
  const screen = screenPath === undefined ? undefined : await folder.value.readFile(screenPath);
  return {
    location,
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
