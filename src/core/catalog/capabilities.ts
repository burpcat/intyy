// The capability catalog: which capabilities a tenant can call, and how (section 9 §11).
// `--format tool` prints a tool definition an agent can load (section 2 §12.9). Every state
// shows `draft` until M10 builds trust and approval (section 8). Only
// `src/cli/commands/capability.ts` calls this; every failure is a value.
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { Artifact } from "../model/artifact.js";
import type { ContractInput } from "../model/artifact/contract.js";
import { listArtifacts, newestVersion, readArtifact, type ArtifactStore } from "./artifacts.js";

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
  /** Always `draft`: no context has approved a capability yet (section 8, M10). */
  state: "draft";
};

/** Every sealed capability, one row per distinct major version, at its newest sealed version. */
export async function listCapabilities(store: ArtifactStore): Promise<Outcome<CapabilitySummary[], "invalid">> {
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
    out.push({ app: g.app, capability: g.capability, major: g.major, effect: read.value.contract.effect, state: "draft" });
  }
  out.sort(
    (a, b) => a.app.localeCompare(b.app) || a.capability.localeCompare(b.capability) || a.major - b.major,
  );
  return ok(out);
}

/** Resolves `<app>/<capability>@<major>` to the newest sealed version of that major
 * (section 9 §7.2). */
export async function resolveMajor(
  store: ArtifactStore,
  app: string,
  capability: string,
  major: number,
): Promise<Outcome<Artifact, "not_found" | "invalid">> {
  const versions = (await store.listSealedVersions(`${app}/${capability}`)).filter(
    (v) => majorOf(v) === major,
  );
  if (versions.length === 0) return fail("not_found", `${app}/${capability}@${String(major)} is not sealed`);
  return readArtifact(store, app, capability, newestVersion(versions));
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
