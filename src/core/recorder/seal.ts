// Sealing and the second look (section 6 §15, section 9 §8.2 "Sealing" and §8.3 "Second look",
// section 8 §10.2 "Four eyes, in two places", section 2 §5.2 "Version rules", §19.4, §19.6).
// `src/cli/commands/candidate.ts` is the only caller: it owns argument parsing, role checks,
// prompting, printing, and writing the drafts and fixtures this returns to the library paths
// section 9 §6.2 names (this module never imports `node:fs`). Every failure is an `Outcome`.
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { RunFolder } from "../../ports/stores.js";
import { Artifact } from "../model/artifact.js";
import { checkArtifact, type ArtifactCheckContext } from "../model/artifact-checks.js";
import type { Contract } from "../model/artifact/contract.js";
import type { HandlerDraft } from "../model/handler-draft.js";
import { regenerateCandidate, resolveSubject, type CandidateDeps } from "./candidates.js";
import type { NormalFixture } from "./drafts.js";
import type { RecorderOutput } from "./record.js";

/** Where each of section 5 §13.1's fixture files comes from, among a turn's own saved captures
 * (section 3 §7.4). */
const FIXTURE_FILE_KINDS: readonly { prefix: string; name: string }[] = [
  { prefix: "a11y/", name: "a11y.yaml" },
  { prefix: "dom/", name: "dom.html" },
  { prefix: "screens/", name: "screen.png" },
];

/** One `normal` fixture, with its files read back from the run folder. `missing` names a
 * section 5 §13.1 file the run never saved for that turn (such as a withheld screenshot):
 * left out, never invented (CLAUDE.md). */
export type SealedFixture = {
  fixture: NormalFixture;
  bytes: Readonly<Record<string, Uint8Array>>;
  missing: readonly string[];
};

/** Reads back one `normal` fixture's own capture files from the positive run's folder. */
async function resolveFixtureFiles(folder: RunFolder, fixture: NormalFixture): Promise<SealedFixture> {
  const bytes: Record<string, Uint8Array> = {};
  const missing: string[] = [];
  for (const { prefix, name } of FIXTURE_FILE_KINDS) {
    const path = fixture.files.find((f) => f.startsWith(prefix));
    const read = path === undefined ? undefined : await folder.readFile(path);
    if (read === undefined || !read.ok) missing.push(name);
    else bytes[name] = read.value;
  }
  return { fixture, bytes, missing };
}

/**
 * Records another reviewer's answer to a lowered risk flag (section 9 §8.3, section 8 §10.2).
 * `--agree` confirms the lowering, as `risk_second_look`, and the blocking issue clears.
 * `--disagree` raises the step back to `irreversible`, as a `risk` decision by the second
 * reviewer: raising risk never needs a third person. Refuses the staff ID that made the `risk`
 * decision under review.
 */
export async function secondLook(
  deps: CandidateDeps,
  id: string,
  subject: string,
  staff: string,
  agree: boolean,
  note: string | undefined,
): Promise<Outcome<RecorderOutput, "not_found" | "invalid" | "write_failed" | "rule">> {
  const artifact = await deps.candidates.getFile(id, "candidate.json");
  if (!artifact.ok) return artifact;
  const decisions = await deps.candidates.decisions(id);
  if (!decisions.ok) return decisions;
  const mapped = resolveSubject(artifact.value, decisions.value, "risk", subject);
  if (mapped === null) return fail("invalid", `${subject} is not a known risk subject`);
  const lastRisk = [...decisions.value].reverse().find((d) => d.what === "risk" && d.subject === mapped);
  if (lastRisk === undefined) {
    return fail("invalid", `${mapped} has no risk decision yet; decide its risk first`);
  }
  if (lastRisk.by === staff) {
    return fail("rule", `${staff} made that risk decision; another staff ID must give the second look`);
  }
  const decision = {
    schema: "intyy.candidate_decision/1.0" as const,
    what: agree ? ("risk_second_look" as const) : ("risk" as const),
    subject: mapped,
    value: agree ? lastRisk.value : "irreversible",
    by: staff,
    at: deps.clock.now().toISOString(),
    ...(note === undefined || note === "" ? {} : { note }),
  };
  const appended = await deps.candidates.appendDecision(id, decision);
  if (!appended.ok) return appended;
  const runs = await deps.candidates.getFile(id, "runs.json");
  if (!runs.ok) return runs;
  return regenerateCandidate(deps, id, runs.value);
}

/** How one contract change differs from another, by semver segment (section 2 §5.2). */
export type Bump = "major" | "minor" | "patch";

const RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };

/**
 * The smallest bump section 2 §5.2 needs, comparing `next`'s contract against `prev`'s. Only
 * what the table names; an unlisted change (such as an input's own type changing under the
 * same name) does not raise the bump on its own.
 */
export function neededBump(prev: Contract, next: Contract): Bump {
  if (prev.effect !== next.effect) return "major";
  const prevIn = new Map(prev.inputs.map((i) => [i.name, i] as const));
  const nextIn = new Map(next.inputs.map((i) => [i.name, i] as const));
  const prevOut = new Map(prev.outputs.map((o) => [o.name, o] as const));
  const nextOut = new Map(next.outputs.map((o) => [o.name, o] as const));
  const prevOutcomes = new Set(prev.outcomes.map((o) => o.code));
  const nextOutcomes = new Set(next.outcomes.map((o) => o.code));

  for (const name of prevIn.keys()) if (!nextIn.has(name)) return "major"; // input removed
  for (const [name, out] of prevOut) {
    const found = nextOut.get(name);
    if (found !== undefined && found.type !== out.type) return "major"; // output type changed
  }
  for (const [name, input] of nextIn) {
    if (!prevIn.has(name) && input.required) return "major"; // new required input
  }
  for (const code of prevOutcomes) if (!nextOutcomes.has(code)) return "major"; // outcome removed

  let bump: Bump = "patch";
  for (const [name, input] of nextIn) {
    if (!prevIn.has(name) && !input.required) bump = "minor"; // new optional input
  }
  for (const name of nextOut.keys()) if (!prevOut.has(name)) bump = "minor"; // new output
  for (const code of nextOutcomes) if (!prevOutcomes.has(code)) bump = "minor"; // new outcome
  return bump;
}

/** How `next` differs from `prev`, by which semver segment changed first. `null` when equal. */
function actualBump(prev: string, next: string): Bump | null {
  const p = prev.split(".").map(Number);
  const n = next.split(".").map(Number);
  if (n[0] !== p[0]) return "major";
  if (n[1] !== p[1]) return "minor";
  if (n[2] !== p[2]) return "patch";
  return null;
}

/** `-1`, `0`, or `1`, comparing two semver strings numerically (never as plain text). */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** The newest of a list of sealed semver strings. Throws on an empty list: the caller checks first. */
export function newestVersion(versions: readonly string[]): string {
  return versions.reduce((best, v) => (compareSemver(v, best) > 0 ? v : best));
}

/**
 * The version the CLI should propose (section 9 §8.2): `1.0.0` with no earlier version, else
 * the previous version bumped by {@link neededBump}.
 */
export function proposeVersion(previous: { version: string; contract: Contract } | null, next: Contract): string {
  if (previous === null) return "1.0.0";
  const [maj, min, pat] = previous.version.split(".").map(Number);
  const bump = neededBump(previous.contract, next);
  if (bump === "major") return `${String((maj ?? 0) + 1)}.0.0`;
  if (bump === "minor") return `${String(maj ?? 0)}.${String((min ?? 0) + 1)}.0`;
  return `${String(maj ?? 0)}.${String(min ?? 0)}.${String((pat ?? 0) + 1)}`;
}

/** Checks a chosen version against the previous one, if any (section 2 §5.2, section 9 §8.2:
 * "a smaller bump than the rules need is refused; a larger one is allowed"). */
function checkVersion(
  previous: { version: string; contract: Contract } | null,
  next: Contract,
  version: string,
): Outcome<void, "invalid" | "conflict"> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return fail("invalid", `${version} is not a semver like 1.0.0`);
  if (previous === null) return ok(undefined);
  const need = neededBump(previous.contract, next);
  const actual = actualBump(previous.version, version);
  if (actual === null) {
    // Why `conflict`, not `invalid`: this is the same rule the store's own `seal` enforces
    // (section 9 §6.2), caught here first because the version bump check runs before it.
    return fail("conflict", `${version} is already sealed`);
  }
  if (RANK[actual] < RANK[need]) {
    return fail(
      "invalid",
      `${version} is only a ${actual} bump; this change needs at least a ${need} bump ` +
        `(propose ${proposeVersion(previous, next)})`,
    );
  }
  return ok(undefined);
}

/** What sealing hands back to the CLI to print and to write under `library/` (section 9 §6.2). */
export type SealResult = {
  /** `<app>/<capability>@<version>`, in key notation (section 9 §8.2: "prints the next command"). */
  key: string;
  artifact: Artifact;
  hash: string;
  drafts: readonly HandlerDraft[];
  normalFixtures: readonly SealedFixture[];
};

/**
 * Seals a candidate as one artifact version (section 6 §15's four rules). Always rebuilds the
 * candidate from its linked runs and every decision first: sealing never trusts `candidate.json`
 * or `issues.json` on disk, only the append-only decision log (docs/decisions.md, M04). The
 * candidate's own files, and the run folders it reads, are never modified.
 */
export async function sealCandidate(
  deps: CandidateDeps,
  id: string,
  version: string,
  staff: string,
  context: ArtifactCheckContext,
): Promise<Outcome<SealResult, "not_found" | "invalid" | "write_failed" | "conflict">> {
  const runsRead = await deps.candidates.getFile(id, "runs.json");
  if (!runsRead.ok) return runsRead;
  const regenerated = await regenerateCandidate(deps, id, runsRead.value);
  if (!regenerated.ok) return regenerated;
  const { candidate, issues, drafts, crops, normalFixtures } = regenerated.value;

  // Rule 1: zero blocking review issues. `null_version` and `null_sealed` are the two
  // placeholders sealing itself fills in next, not a review gap left for a human (section 6
  // §14.15; rule 4, the risk second look, is one of `issues` too — `applyRiskDecisions`
  // raises it unconditionally, so it is never missed here even from a stale issues.json).
  const blocking = issues.filter(
    (i) => i.level === "blocking" && i.code !== "null_version" && i.code !== "null_sealed",
  );
  if (blocking.length > 0) {
    return fail("invalid", blocking.map((i) => `${i.code}: ${i.message}`).join("\n"));
  }

  // Rule 3: the version bump.
  const artifactId = `${candidate.identity.app}/${candidate.identity.capability}`;
  const versions = await deps.candidates.listSealedVersions(artifactId);
  let previous: { version: string; contract: Contract } | null = null;
  if (versions.length > 0) {
    const latest = newestVersion(versions);
    const read = await deps.candidates.getSealedArtifact(artifactId, latest);
    if (!read.ok) return read;
    const parsed = Artifact.safeParse(read.value);
    if (!parsed.success || parsed.data.identity.version === null) {
      return fail("invalid", `${artifactId}@${latest}: the sealed file does not fit its schema`);
    }
    previous = { version: parsed.data.identity.version, contract: parsed.data.contract };
  }
  const versionCheck = checkVersion(previous, candidate.contract, version);
  if (!versionCheck.ok) return versionCheck;

  // Set identity.version and provenance.sealed, then rule 2: the strict loader, including the
  // section 2 §19.6 policy checks `context` carries.
  const sealedArtifact: Artifact = {
    ...candidate,
    identity: { ...candidate.identity, version },
    provenance: { ...candidate.provenance, sealed: { by: staff, at: deps.clock.now().toISOString() } },
  };
  const problems = checkArtifact(sealedArtifact, "strict", context);
  const errors = problems.filter((p) => p.level === "error");
  if (errors.length > 0) {
    return fail("invalid", errors.map((p) => `${p.path}: ${p.message}`).join("\n"));
  }

  // Crops: read-only from the positive run's own folder; never written back to it.
  const opened = await deps.evidence.openRun(runsRead.value.positive.tenant, runsRead.value.positive.run_id);
  if (!opened.ok) return opened;
  const cropBytes: Record<string, Uint8Array> = {};
  for (const [targetId, path] of crops) {
    const read = await opened.value.readFile(path);
    if (!read.ok) return fail("invalid", `${targetId}'s crop, ${path}, is missing from the run folder`);
    cropBytes[targetId] = read.value;
  }

  const sealed = await deps.candidates.seal(id, version, staff, sealedArtifact, cropBytes);
  if (!sealed.ok) return sealed;

  const sealedFixtures: SealedFixture[] = [];
  for (const fixture of normalFixtures) sealedFixtures.push(await resolveFixtureFiles(opened.value, fixture));

  return ok({
    key: `${artifactId}@${version}`,
    artifact: sealedArtifact,
    hash: sealed.value.hash,
    drafts,
    normalFixtures: sealedFixtures,
  });
}
