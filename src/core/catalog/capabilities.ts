// The capability catalog: which capabilities a tenant can call, and how (section 9 §11).
// `--format tool` prints a tool definition an agent can load (section 2 §12.9). The state of a
// capability comes from the score records (section 8 §4, M10): the caller passes a lookup, and
// with none every state is `draft`. Every failure is a value.
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { Artifact } from "../model/artifact.js";
import { matchesAnyPattern } from "../model/artifact-checks-shared.js";
import type { TrustState } from "../model/score.js";
import type { ContractInput } from "../model/artifact/contract.js";
import { compareSemver, listArtifacts, newestVersion, readArtifact, type ArtifactStore } from "./artifacts.js";

/** The major version segment of a semver string, like `1` from `1.2.0`. */
function majorOf(version: string): number {
  return Number(version.split(".")[0]);
}

/** One capability, at its major version: what `capability list` shows (section 9 §11). */
export type CapabilitySummary = {
  app: string;
  capability: string;
  major: number;
  effect: Artifact["contract"]["effect"];
  /** The capability's trust state in the tenant's context (section 8 §4); `draft` with no records. */
  state: TrustState;
};

/** Every sealed capability, one row per distinct major version, at its newest sealed version. */
export async function listCapabilities(
  store: ArtifactStore,
  /** The state of `<app>/<capability>` at `major` in the tenant's context. Omitted: `draft`. */
  stateOf: (name: string, major: number) => TrustState = () => "draft",
): Promise<Outcome<CapabilitySummary[], "invalid">> {
  const artifacts = await listArtifacts(store);
  const groups = new Map<string, { app: string; capability: string; major: number; versions: string[] }>();
  for (const a of artifacts) {
    const major = majorOf(a.version);
    const key = `${a.app}/${a.capability}@${String(major)}`;
    const g = groups.get(key) ?? { app: a.app, capability: a.capability, major, versions: [] };
    g.versions.push(a.version);
    groups.set(key, g);
  }
  const out: CapabilitySummary[] = [];
  for (const g of groups.values()) {
    const read = await readArtifact(store, g.app, g.capability, newestVersion(g.versions));
    // Why `invalid`, not `not_found`: the index just named this version as sealed, so a
    // missing file here is a store inconsistency, not an absent capability.
    if (!read.ok) return fail("invalid", read.detail ?? read.failure);
    out.push({ app: g.app, capability: g.capability, major: g.major, effect: read.value.contract.effect, state: stateOf(`${g.app}/${g.capability}`, g.major) });
  }
  out.sort(
    (a, b) => a.app.localeCompare(b.app) || a.capability.localeCompare(b.capability) || a.major - b.major,
  );
  return ok(out);
}

/**
 * Resolves `<app>/<capability>@<major>` to a sealed version of that major (section 9 §7.2).
 * With no `appVersion`, the newest sealed version wins, as `capability describe` always
 * wanted. With one, this is the M05 resolver (section 3 §4.8 checks 4 and 5): the newest
 * sealed version of the major whose `runs_on.app_versions` fits it, checking versions newest
 * first so an older, fitting version is not shadowed by a newer one that does not fit.
 */
export async function resolveMajor(
  store: ArtifactStore,
  app: string,
  capability: string,
  major: number,
  appVersion?: string,
): Promise<Outcome<Artifact, "not_found" | "invalid">> {
  const versions = (await store.listSealedVersions(`${app}/${capability}`)).filter(
    (v) => majorOf(v) === major,
  );
  if (versions.length === 0) return fail("not_found", `${app}/${capability}@${String(major)} is not sealed`);
  if (appVersion === undefined) return readArtifact(store, app, capability, newestVersion(versions));
  for (const v of versions.sort((a, b) => compareSemver(b, a))) {
    const read = await readArtifact(store, app, capability, v);
    if (!read.ok) return read;
    if (matchesAnyPattern(read.value.runs_on.app_versions, appVersion)) return ok(read.value);
  }
  return fail(
    "not_found",
    `${app}/${capability}@${String(major)} has no sealed version for app version ${appVersion}`,
  );
}

/**
 * Every sealed version of a major that fits the bank's app version, newest first (section 8 §11.2).
 * A version that cannot be read is left out: the resolver then never picks it.
 */
export async function fittingVersions(
  store: ArtifactStore,
  app: string,
  capability: string,
  major: number,
  appVersion: string,
): Promise<Artifact[]> {
  const versions = (await store.listSealedVersions(`${app}/${capability}`))
    .filter((v) => majorOf(v) === major)
    .sort((a, b) => compareSemver(b, a));
  const out: Artifact[] = [];
  for (const v of versions) {
    const read = await readArtifact(store, app, capability, v);
    if (read.ok && matchesAnyPattern(read.value.runs_on.app_versions, appVersion)) out.push(read.value);
  }
  return out;
}

/** `input_schema`'s JSON Schema type for one value type (section 2 §12.3, §12.9). `money` and
 * `decimal` are decimal strings, not JSON numbers (section 6 §6.1). */
function jsonTypeFor(type: ContractInput["type"]): Record<string, unknown> {
  switch (type) {
    case "integer":
      return { type: "integer" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date" };
    case "string":
    case "decimal":
    case "money":
    case "enum":
      return { type: "string" };
  }
}

/** The contract's inputs as JSON Schema (section 2 §12.9): the calling agent's own tool schema.
 * Steps, targets, and conditions stay hidden. */
export function inputsJsonSchema(inputs: readonly ContractInput[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const i of inputs) {
    const schema: Record<string, unknown> = { ...jsonTypeFor(i.type), description: i.description };
    if (i.constraints?.values !== undefined) schema.enum = i.constraints.values;
    properties[i.name] = schema;
    if (i.required) required.push(i.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/** The four caller rules a tool description carries (section 2 §5.3): new outcomes are minor,
 * so a caller must read leniently. */
const CALLER_RULES =
  "1. An unknown outcome code is a generic business outcome. Show its description.\n" +
  "2. An unknown failure code is a generic failure. Trust its transient and safe_to_retry flags.\n" +
  "3. An unknown warning code is ignored.\n" +
  "4. An unknown result field is ignored.";

/** A tool definition an agent can load (section 2 §12.9, section 9 §11): name, description,
 * and input schema. */
export type ToolDefinition = { name: string; description: string; input_schema: unknown };

/** Builds one capability's tool definition, at `major` (section 9 §11). */
export function toolDefinition(artifact: Artifact, major: number): ToolDefinition {
  const name = `${artifact.identity.app}__${artifact.identity.capability}__v${String(major)}`;
  const description = [artifact.about.summary, artifact.about.when_to_use, CALLER_RULES].join("\n\n");
  return { name, description, input_schema: inputsJsonSchema(artifact.contract.inputs) };
}

/**
 * Reads one exact sealed version (a certify pin, section 3 §4.9: "the exact key under test").
 * `not_found` when that version is not sealed, or (given `appVersion`) does not fit it.
 */
export async function resolveExact(
  store: ArtifactStore,
  app: string,
  capability: string,
  version: string,
  appVersion?: string,
): Promise<Outcome<Artifact, "not_found" | "invalid">> {
  const versions = await store.listSealedVersions(`${app}/${capability}`);
  if (!versions.includes(version)) return fail("not_found", `${app}/${capability}@${version} is not sealed`);
  const read = await readArtifact(store, app, capability, version);
  if (!read.ok) return read;
  if (appVersion !== undefined && !matchesAnyPattern(read.value.runs_on.app_versions, appVersion)) {
    return fail("not_found", `${app}/${capability}@${version} does not fit app version ${appVersion}`);
  }
  return ok(read.value);
}
