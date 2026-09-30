// Reading back sealed artifacts (section 9 §6.4, §11; section 2 §19, §5.2). `list`, `show`, and
// `verify` are read-only: they never write to a candidate or a run folder. Only
// `src/cli/commands/artifact.ts` calls this; every failure is a value, never a throw.
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { CandidateStore, Rev } from "../../ports/stores.js";
import { Artifact } from "../model/artifact.js";
import { checkArtifact, type ArtifactCheckContext } from "../model/artifact-checks.js";
import { issueText } from "../model/sealing.js";
import type { CandidateDecision } from "../model/candidate-decision.js";
import type { CandidateFiles } from "../recorder/candidates.js";

/** The store `artifact` and `capability` commands both read from. */
export type ArtifactStore = CandidateStore<CandidateFiles, CandidateDecision>;

/** One sealed artifact, as `artifact list` shows it. */
export type ArtifactSummary = { app: string; capability: string; version: Rev };

/** Splits a store artifact ID (`<app>/<capability>`) into its two parts. */
function splitArtifactId(id: string): { app: string; capability: string } {
  const cut = id.indexOf("/");
  return cut < 0 ? { app: id, capability: "" } : { app: id.slice(0, cut), capability: id.slice(cut + 1) };
}

/** Every sealed artifact, sorted by app, then capability, then version. */
export async function listArtifacts(store: ArtifactStore): Promise<ArtifactSummary[]> {
  const rows = await store.listSealedArtifacts();
  return rows
    .map((r) => ({ ...splitArtifactId(r.id), version: r.version }))
    .sort(
      (a, b) =>
        a.app.localeCompare(b.app) ||
        a.capability.localeCompare(b.capability) ||
        compareSemver(a.version, b.version),
    );
}

/** `-1`, `0`, or `1`, comparing two semver strings numerically (never as plain text). */
export function compareSemver(a: string, b: string): number {
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

/** Reads one sealed artifact, schema-checked. Its own hash is checked against the index line
 * by the store (section 9 §6.4). */
export async function readArtifact(
  store: ArtifactStore,
  app: string,
  capability: string,
  version: Rev,
): Promise<Outcome<Artifact, "not_found" | "invalid">> {
  const read = await store.getSealedArtifact(`${app}/${capability}`, version);
  if (!read.ok) return read;
  const parsed = Artifact.safeParse(read.value);
  if (!parsed.success) return fail("invalid", issueText(parsed.error));
  return ok(parsed.data);
}

/** One problem `verifyArtifact` found. */
export type VerifyProblem = { code: string; message: string };

/** What `artifact verify` prints (section 9 §11, section 2 §19). */
export type VerifyResult = { ok: boolean; problems: readonly VerifyProblem[] };

/**
 * Re-reads a sealed artifact (its own hash checked against the index, section 9 §6.4), runs the
 * strict loader with the policy context (section 2 §19.6), and checks every target with an
 * `image` clue has its crop file. `not_found` only when the key was never sealed at all; every
 * other problem (a changed file, a schema break, a missing crop) is a listed problem instead,
 * so the caller can print them all at once.
 */
export async function verifyArtifact(
  store: ArtifactStore,
  app: string,
  capability: string,
  version: Rev,
  context: ArtifactCheckContext,
): Promise<Outcome<VerifyResult, "not_found">> {
  const artifactId = `${app}/${capability}`;
  const read = await store.getSealedArtifact(artifactId, version);
  if (!read.ok) {
    if (read.failure === "not_found") return fail("not_found", read.detail);
    return ok({ ok: false, problems: [{ code: "invalid", message: read.detail ?? "the sealed file changed" }] });
  }
  const parsed = Artifact.safeParse(read.value);
  if (!parsed.success) {
    return ok({ ok: false, problems: [{ code: "schema_invalid", message: issueText(parsed.error) }] });
  }
  const problems: VerifyProblem[] = [];
  for (const p of checkArtifact(parsed.data, "strict", context)) {
    if (p.level === "error") problems.push({ code: p.code, message: `${p.path}: ${p.message}` });
  }
  for (const t of parsed.data.targets) {
    if (t.clues.image === undefined) continue;
    const crop = await store.getSealedCrop(artifactId, version, t.id);
    if (!crop.ok) problems.push({ code: "missing_crop", message: `${t.id}: ${t.clues.image} is missing` });
  }
  return ok({ ok: problems.length === 0, problems });
}
