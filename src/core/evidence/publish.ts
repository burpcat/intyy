// Evidence publish and verify: copy chosen runs, batches, and sealed artifacts into the repo's
// `evidence/` folder, safely, and re-check a published set later.
// Follows design section 9 §6.6, the updates file §12 (artifacts, canary sources, size warning),
// and build plan section 10 §11 (layout, 60 MB budget). Core has no `node:fs`: files come and go
// through the file tree port. Every check runs in memory before the first byte is written.
import { sha256Hex } from "../model/canonical.js";
import { BatchPlan } from "../model/batch-plan.js";
import { BatchReport } from "../model/batch-report.js";
import { PublishManifest, type PublishItem } from "../model/publish.js";
import { HistoryLine } from "../model/score-history.js";
import { RunJson } from "../model/run.js";
import { sealHash } from "../model/sealing.js";
import { IndexLine } from "../model/store-index.js";
import type { Clock } from "../../ports/clock.js";
import { fail, ok, type Outcome } from "../../ports/outcome.js";
import type { FileTree } from "../../ports/tree.js";
import { scanForCanaries, type CanaryHit } from "../safety/canary/scan.js";
import { Redactor, type RedactionRules } from "../safety/redaction/redactor.js";
import { unmaskedLabelledLines } from "../safety/redaction/snapshots.js";

/** The size past which publish warns (build plan section 10 §11.3). It never refuses for size. */
export const SIZE_WARN_BYTES = 60 * 1024 * 1024;

/** The manifest's path under `evidence/`. */
export const MANIFEST_PATH = "manifest.json";

/** Paths under `evidence/` that no publish copies, so verify does not call them unlisted: the
 * hand-written index, and the test report (`npm run test:safety`). */
const UNLISTED_OK = (path: string): boolean =>
  path === MANIFEST_PATH || path === "README.md" || path.startsWith("tests/");

/** Names evidence never holds (CLAUDE.md, Data): cookies, storage state, traces, HAR, video. */
const FORBIDDEN =
  /(^|\/)(traces?|videos?|har)\/|(^|\/)([^/]*\.(har|webm|mp4|mkv)|trace\.zip|(cookies?|storage[_-]?state)(\.[a-z]+)?)$/i;

/** What to publish: one run, one batch, or a key's trust snapshot (`id` is its key path, section 9 §6.6). */
export type PublishTarget = { kind: "run" | "batch" | "key"; id: string };

/** What `publishEvidence` needs. */
export type PublishInput = {
  tenant: string;
  targets: readonly PublishTarget[];
  /** `all`: a batch publishes every run it ran. Default: only runs whose verdict is not `pass`. */
  withRuns?: "all";
  /** The staff ID that publishes. */
  by: string;
  /** Canary values: `canary_members` plus every bound secret value. Memory only, never printed. */
  markers: readonly string[];
  /**
   * The policy's redaction rules. When given, every accessibility snapshot is checked again by
   * the label rule (section 4 §9.7); a labelled cell still raw refuses. The CLI always passes it.
   */
  redaction?: RedactionRules;
};

/** The ports `publishEvidence` and `verifyEvidence` use. */
export type PublishDeps = {
  /** `state/evidence/`: tenant folders with `runs/`, `batches/`, and `index.jsonl`. */
  source: FileTree;
  /** `library/artifacts/`: sealed artifact versions and their `index.jsonl`. */
  library: FileTree;
  /** The repo's `evidence/`. */
  dest: FileTree;
  /** `state/trust/scores/`: the score files a key target copies. Omitted: key targets are `not_found`. */
  trust?: FileTree;
  clock: Clock;
};

/** Why a publish refused. `detail` names paths, run IDs, and canary positions, never a value. */
export type PublishFailure =
  | "not_found"
  | "run_invalid"
  | "hash_mismatch"
  | "not_indexed"
  | "index_mismatch"
  | "link_missing"
  | "forbidden_file"
  | "artifact_mismatch"
  | "canary_hit"
  | "unmasked_label"
  | "manifest_invalid"
  | "write_failed";

/** What a successful publish did. */
export type PublishReport = {
  runs: string[];
  batches: string[];
  artifacts: string[];
  files: number;
  /** Bytes copied by this publish. */
  bytes: number;
  /** Bytes in `evidence/` after it. */
  totalBytes: number;
  warnings: string[];
};

const dec = new TextDecoder();
const enc = new TextEncoder();

/** Parses JSON bytes, or `undefined` when they are not JSON. */
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(dec.decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/** `app/capability@version` split into its three parts, or `undefined`. */
function splitArtifactId(id: unknown): { artifact: string; version: string } | undefined {
  if (typeof id !== "string") return undefined;
  const m = /^([a-z][a-z0-9_-]*\/[a-z][a-z0-9_]*)@(\d+\.\d+\.\d+)$/.exec(id);
  return m?.[1] === undefined || m[2] === undefined ? undefined : { artifact: m[1], version: m[2] };
}

/** `frozen.artifact.id` and `frozen.session.id` of a run, as artifact IDs the run names. */
function artifactsNamed(run: RunJson): string[] {
  if (run.kind === "discovery") return [];
  // Why both shapes: the replay engine copies `run_start`'s whole data (the facts sit under a
  // nested `frozen`), and the crash sweep copies only its inner `frozen` block.
  const outer = run.frozen;
  const inner = outer.frozen;
  const blocks = [outer, ...(typeof inner === "object" && inner !== null ? [inner as Record<string, unknown>] : [])];
  const ids: string[] = [];
  for (const b of blocks) {
    for (const k of ["artifact", "session"]) {
      const ref = b[k];
      const id = typeof ref === "object" && ref !== null ? (ref as { id?: unknown }).id : undefined;
      if (typeof id === "string") ids.push(id);
    }
  }
  return [...new Set(ids)];
}

/** One run folder read from the source: its `run.json` and every file under it. */
type SourceRun = { run: RunJson; files: Map<string, Uint8Array> };

/** The refusal text for scan hits: file, form, and marker position only. */
function hitText(hits: readonly CanaryHit[]): string {
  return hits.map((h) => `${h.path} (${h.form}, marker #${String(h.marker + 1)})`).join("; ");
}

/** An accessibility snapshot: a run's `a11y/<seq>_<name>.yaml`, or a fixture's `a11y.yaml`. */
const A11Y_FILE = /(^|\/)a11y(\/[^/]+)?\.yaml$/;

/**
 * Re-runs the label rule over each accessibility snapshot to publish. Names the file and line of
 * each labelled cell still raw, never the value. Why: defence in depth for the M05 leak
 * (docs/decisions.md), like the canary scan.
 */
function labelLeaks(files: ReadonlyMap<string, Uint8Array>, r: Redactor): string[] {
  const out: string[] = [];
  for (const [path, bytes] of files) {
    if (!A11Y_FILE.test(path)) continue;
    for (const line of unmaskedLabelledLines(dec.decode(bytes), r)) out.push(`${path} (line ${String(line)})`);
  }
  return out;
}

/** Checks each file `run.json` lists against its bytes. Returns the problems found. */
function runFileProblems(run: RunJson, read: (rel: string) => Uint8Array | undefined): string[] {
  if (run.kind === "discovery") return [];
  const bad: string[] = [];
  for (const f of run.files) {
    const bytes = read(f.path);
    if (bytes === undefined) bad.push(`${run.run_id}/${f.path} is missing`);
    else if (`sha256:${sha256Hex(bytes)}` !== f.sha256) bad.push(`${run.run_id}/${f.path} does not match its hash`);
  }
  return bad;
}

/** Reads one source run folder in full. */
async function readRun(
  source: FileTree,
  tenant: string,
  runId: string,
): Promise<Outcome<SourceRun, "not_found" | "run_invalid">> {
  const prefix = `${tenant}/runs/${runId}/`;
  const listed = await source.list(prefix);
  if (listed.length === 0) return fail("not_found", `run ${runId} is not in the ${tenant} evidence`);
  const files = new Map<string, Uint8Array>();
  for (const f of listed) {
    const got = await source.read(f.path);
    if (got.ok) files.set(f.path.slice(prefix.length), got.value);
  }
  const raw = files.get("run.json");
  const parsed = raw === undefined ? undefined : RunJson.safeParse(parseJson(raw));
  if (parsed === undefined || !parsed.success) return fail("run_invalid", `run ${runId}: run.json is missing or does not parse`);
  if (parsed.data.run_id !== runId) return fail("run_invalid", `run ${runId}: run.json names another run`);
  return ok({ run: parsed.data, files });
}

/** Every `run.json` in the tenant that parses, by run ID (to find a run's children). */
async function childrenOf(source: FileTree, tenant: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const f of await source.list(`${tenant}/runs/`)) {
    if (!/^[^/]+\/runs\/[^/]+\/run\.json$/.test(f.path)) continue;
    const got = await source.read(f.path);
    const parsed = got.ok ? RunJson.safeParse(parseJson(got.value)) : undefined;
    if (parsed === undefined || !parsed.success || parsed.data.kind === "discovery") continue;
    const parent = parsed.data.parent_run_id;
    if (parent !== null) out.set(parent, [...(out.get(parent) ?? []), parsed.data.run_id]);
  }
  return out;
}

/** The newest `status` per run ID in the tenant's `index.jsonl`. */
async function indexStatuses(source: FileTree, tenant: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const got = await source.read(`${tenant}/index.jsonl`);
  if (!got.ok) return out;
  for (const line of dec.decode(got.value).split("\n")) {
    const row = line.trim() === "" ? undefined : (parseJson(enc.encode(line)) as Record<string, unknown> | undefined);
    if (row !== undefined && typeof row.run_id === "string" && typeof row.status === "string") {
      out.set(row.run_id, row.status);
    }
  }
  return out;
}

/** A sealed artifact version's files, hash-checked against the artifact index. */
async function readArtifact(
  library: FileTree,
  artifact: string,
  version: string,
): Promise<Outcome<{ hash: string; files: Map<string, Uint8Array> }, "artifact_mismatch">> {
  const name = `${artifact}@${version}`;
  const index = await library.read("index.jsonl");
  let sealed: string | undefined;
  if (index.ok) {
    for (const line of dec.decode(index.value).split("\n")) {
      const parsed = IndexLine.safeParse(line.trim() === "" ? undefined : parseJson(enc.encode(line)));
      if (parsed.success && parsed.data.event === "sealed" && parsed.data.id === artifact && parsed.data.rev === version) {
        sealed = parsed.data.hash;
      }
    }
  }
  if (sealed === undefined) return fail("artifact_mismatch", `${name} is not in the artifact index`);
  const prefix = `${artifact}/${version}/`;
  const files = new Map<string, Uint8Array>();
  for (const f of await library.list(prefix)) {
    const got = await library.read(f.path);
    if (got.ok) files.set(f.path.slice(prefix.length), got.value);
  }
  const doc = files.get("artifact.json");
  if (doc === undefined) return fail("artifact_mismatch", `${name}: artifact.json is missing`);
  if (sealHash(parseJson(doc)) !== sealed) return fail("artifact_mismatch", `${name} changed after sealing`);
  return ok({ hash: sealed, files });
}

/** The run IDs a batch publishes: runs whose verdict is not `pass`, or every run with `all`. */
function batchRunIds(plan: BatchPlan, report: BatchReport, all: boolean): string[] {
  const ids = new Set<string>();
  for (const c of report.cases) if (all || c.verdict !== "pass") ids.add(c.run_id);
  if (all) for (const c of plan.cases) ids.add(c.run_id);
  return [...ids];
}

/** Where trust snapshots land under `evidence/` (updates file §12): it mirrors `state/trust/scores/`. */
const TRUST_DIR = "trust/scores";

/** A key's history and record bytes, and the batch IDs its history names (section 9 §6.6: "the plan and report of each batch its history names"). */
async function readKey(
  trust: FileTree | undefined,
  tenant: string,
  path: string,
): Promise<Outcome<{ files: { history: Uint8Array; record: Uint8Array }; batches: string[] }, "not_found" | "run_invalid">> {
  if (!path.startsWith(`${tenant}/`) || trust === undefined) return fail("not_found", `key ${path} is not in the ${tenant} trust store`);
  const history = await trust.read(`${path}/history.jsonl`);
  const record = await trust.read(`${path}/record.json`);
  if (!history.ok || !record.ok) return fail("not_found", `key ${path} has no history.jsonl and record.json`);
  const batches = new Set<string>();
  for (const [i, line] of dec.decode(history.value).split("\n").entries()) {
    if (line.trim() === "") continue;
    const parsed = HistoryLine.safeParse(parseJson(enc.encode(line)));
    if (!parsed.success) return fail("run_invalid", `key ${path}: history line ${String(i + 1)} does not parse`);
    if ("batch" in parsed.data && parsed.data.batch !== null) batches.add(parsed.data.batch);
  }
  return ok({ files: { history: history.value, record: record.value }, batches: [...batches] });
}

/**
 * Copies the targets into `evidence/`. Order: resolve the set (a run pulls its parent, its
 * children, and its batch's plan and report), then check every run (file hashes, index line,
 * forbidden files), every artifact (seal hash), and scan every byte for canaries, then write
 * the files, then write the manifest. A refusal writes nothing. Section 9 §6.6.
 */
export async function publishEvidence(
  input: PublishInput,
  deps: PublishDeps,
): Promise<Outcome<PublishReport, PublishFailure>> {
  const { tenant } = input;
  const runs = new Map<string, SourceRun>();
  const batches = new Map<string, { plan: Uint8Array; report: Uint8Array }>();
  const queue: string[] = [];
  const kids = await childrenOf(deps.source, tenant);

  const addBatch = async (id: string): Promise<Outcome<{ runs: string[] }, "not_found" | "run_invalid">> => {
    const dir = `${tenant}/batches/${id}`;
    const plan = await deps.source.read(`${dir}/plan.json`);
    const report = await deps.source.read(`${dir}/report.json`);
    if (!plan.ok || !report.ok) return fail("not_found", `batch ${id} is not in the ${tenant} evidence`);
    const p = BatchPlan.safeParse(parseJson(plan.value));
    const r = BatchReport.safeParse(parseJson(report.value));
    if (!p.success || !r.success) return fail("run_invalid", `batch ${id}: plan.json or report.json does not parse`);
    batches.set(id, { plan: plan.value, report: report.value });
    return ok({ runs: batchRunIds(p.data, r.data, input.withRuns === "all") });
  };

  const keys = new Map<string, { history: Uint8Array; record: Uint8Array }>();
  for (const t of input.targets) {
    if (t.kind === "run") queue.push(t.id);
    else if (t.kind === "key") {
      const got = await readKey(deps.trust, tenant, t.id);
      if (!got.ok) return got;
      keys.set(t.id, got.value.files);
      for (const id of got.value.batches) {
        if (batches.has(id)) continue;
        const b = await addBatch(id);
        if (!b.ok) return b.failure === "not_found" ? fail("link_missing", b.detail) : b;
        queue.push(...b.value.runs);
      }
    } else {
      const got = await addBatch(t.id);
      if (!got.ok) return got;
      queue.push(...got.value.runs);
    }
  }
  // Why a closure: section 9 §6.6, "Links resolve: every run and batch a published file names is
  // published too." A run names its parent and its batch; a parent names its children.
  while (queue.length > 0) {
    const id = queue.shift() ?? "";
    if (runs.has(id)) continue;
    const got = await readRun(deps.source, tenant, id);
    if (!got.ok) return got.failure === "not_found" ? fail("link_missing", got.detail) : got;
    runs.set(id, got.value);
    const run = got.value.run;
    if (run.kind !== "discovery") {
      if (run.parent_run_id !== null) queue.push(run.parent_run_id);
      if (run.batch_id !== null && !batches.has(run.batch_id)) {
        const b = await addBatch(run.batch_id);
        if (!b.ok) return b.failure === "not_found" ? fail("link_missing", b.detail) : b;
      }
    }
    queue.push(...(kids.get(id) ?? []));
  }

  const statuses = await indexStatuses(deps.source, tenant);
  const out = new Map<string, Uint8Array>();
  const items: PublishItem[] = [];
  for (const [id, { run, files }] of runs) {
    const listed = statuses.get(id);
    if (listed === undefined) return fail("not_indexed", `run ${id} has no line in the ${tenant} index`);
    if (listed !== run.status) return fail("index_mismatch", `run ${id}: run.json says ${run.status}, the index says ${listed}`);
    const bad = runFileProblems(run, (rel) => files.get(rel));
    if (bad.length > 0) return fail("hash_mismatch", bad.join("; "));
    for (const [rel, bytes] of files) {
      if (FORBIDDEN.test(rel)) return fail("forbidden_file", `run ${id}: ${rel}`);
      out.set(`${tenant}/runs/${id}/${rel}`, bytes);
    }
    items.push({ kind: "run", id, tenant });
  }
  for (const [id, b] of batches) {
    out.set(`${tenant}/batches/${id}/plan.json`, b.plan);
    out.set(`${tenant}/batches/${id}/report.json`, b.report);
    items.push({ kind: "batch", id, tenant });
  }
  for (const [path, f] of keys) {
    out.set(`${TRUST_DIR}/${path}/history.jsonl`, f.history);
    out.set(`${TRUST_DIR}/${path}/record.json`, f.record);
    items.push({ kind: "key", id: path, tenant });
  }
  const artifactIds = new Set<string>();
  for (const { run } of runs.values()) for (const a of artifactsNamed(run)) artifactIds.add(a);
  for (const name of [...artifactIds].sort()) {
    const split = splitArtifactId(name);
    if (split === undefined) continue;
    const got = await readArtifact(deps.library, split.artifact, split.version);
    if (!got.ok) return got;
    for (const [rel, bytes] of got.value.files) {
      if (FORBIDDEN.test(rel)) return fail("forbidden_file", `${name}: ${rel}`);
      out.set(`artifacts/${split.artifact}/${split.version}/${rel}`, bytes);
    }
    items.push({ kind: "artifact", id: name, hash: got.value.hash });
  }

  const hits = scanForCanaries(
    [...out].map(([path, bytes]) => ({ path, bytes })),
    input.markers,
  );
  if (hits.length > 0) return fail("canary_hit", hitText(hits));
  if (input.redaction !== undefined) {
    const leaks = labelLeaks(out, new Redactor(input.redaction));
    if (leaks.length > 0) return fail("unmasked_label", leaks.join("; "));
  }

  const manifest = await mergeManifest(deps, input.by, items, out);
  if (!manifest.ok) return manifest;
  const manifestBytes = enc.encode(`${JSON.stringify(manifest.value, null, 2)}\n`);
  const manifestHits = scanForCanaries([{ path: MANIFEST_PATH, bytes: manifestBytes }], input.markers);
  if (manifestHits.length > 0) return fail("canary_hit", hitText(manifestHits));

  const existing = await deps.dest.list("");
  const replaced = new Set(out.keys());
  replaced.add(MANIFEST_PATH);
  let copied = 0;
  for (const bytes of out.values()) copied += bytes.byteLength;
  const kept = existing.filter((f) => !replaced.has(f.path)).reduce((n, f) => n + f.bytes, 0);
  const totalBytes = kept + copied + manifestBytes.byteLength;

  for (const [path, bytes] of out) {
    const w = await deps.dest.write(path, bytes);
    if (!w.ok) return fail("write_failed", `${path}: ${w.detail ?? ""}`);
  }
  const w = await deps.dest.write(MANIFEST_PATH, manifestBytes);
  if (!w.ok) return fail("write_failed", `${MANIFEST_PATH}: ${w.detail ?? ""}`);

  const warnings =
    totalBytes > SIZE_WARN_BYTES
      ? [`evidence/ is ${String(Math.ceil(totalBytes / (1024 * 1024)))} MB, past the 60 MB budget`]
      : [];
  return ok({
    runs: [...runs.keys()].sort(),
    batches: [...batches.keys()].sort(),
    artifacts: [...artifactIds].sort(),
    files: out.size,
    bytes: copied,
    totalBytes,
    warnings,
  });
}

/** The manifest after this publish: the old one's items and hashes, plus the new ones. */
async function mergeManifest(
  deps: PublishDeps,
  by: string,
  items: readonly PublishItem[],
  files: ReadonlyMap<string, Uint8Array>,
): Promise<Outcome<PublishManifest, "manifest_invalid">> {
  const old = await deps.dest.read(MANIFEST_PATH);
  let prior: PublishManifest | undefined;
  if (old.ok) {
    const parsed = PublishManifest.safeParse(parseJson(old.value));
    // Why refuse: a manifest that does not parse may name files this publish would orphan.
    if (!parsed.success) return fail("manifest_invalid", `${MANIFEST_PATH} does not parse; fix or remove it`);
    prior = parsed.data;
  }
  const key = (i: PublishItem): string => `${i.kind}:${i.tenant ?? ""}:${i.id}`;
  const merged = new Map<string, PublishItem>();
  for (const i of [...(prior?.items ?? []), ...items]) merged.set(key(i), i);
  const hashes: Record<string, string> = { ...(prior?.source_hashes ?? {}) };
  for (const [path, bytes] of files) hashes[path] = `sha256:${sha256Hex(bytes)}`;
  const sorted = Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1)));
  return ok(
    PublishManifest.parse({
      schema: "intyy.publish/1.0",
      items: [...merged.values()].sort((a, b) => (key(a) < key(b) ? -1 : 1)),
      by,
      at: deps.clock.now().toISOString(),
      source_hashes: sorted,
    }),
  );
}

/** What `verifyEvidence` found: an empty `problems` list means the set is clean. */
export type VerifyReport = { items: number; files: number; problems: string[] };

/**
 * Re-checks `evidence/` as it stands (section 9 §6.6, "Evidence verify"): the manifest parses;
 * every listed file matches its hash and no unlisted file sits beside them; no forbidden file; each
 * run's own file list matches its bytes; artifacts match their seal hash; links resolve inside the
 * set; and no canary appears anywhere. A missing or bad manifest is a failure, not a problem line.
 */
export async function verifyEvidence(
  input: { markers: readonly string[] },
  deps: Pick<PublishDeps, "dest">,
): Promise<Outcome<VerifyReport, "no_manifest" | "manifest_invalid">> {
  const raw = await deps.dest.read(MANIFEST_PATH);
  if (!raw.ok) return fail("no_manifest", `${MANIFEST_PATH} is missing`);
  const parsed = PublishManifest.safeParse(parseJson(raw.value));
  if (!parsed.success) return fail("manifest_invalid", `${MANIFEST_PATH} does not parse`);
  const manifest = parsed.data;
  const problems: string[] = [];

  const listed = await deps.dest.list("");
  const bytesOf = new Map<string, Uint8Array>();
  for (const f of listed) {
    const got = await deps.dest.read(f.path);
    if (got.ok) bytesOf.set(f.path, got.value);
  }
  for (const [path, hash] of Object.entries(manifest.source_hashes)) {
    const bytes = bytesOf.get(path);
    if (bytes === undefined) problems.push(`${path} is listed but missing`);
    else if (`sha256:${sha256Hex(bytes)}` !== hash) problems.push(`${path} does not match its hash`);
  }
  for (const f of listed) {
    if (FORBIDDEN.test(f.path)) problems.push(`${f.path} is a forbidden file`);
    else if (!(f.path in manifest.source_hashes) && !UNLISTED_OK(f.path)) problems.push(`${f.path} is not in the manifest`);
  }

  const runIds = new Set(manifest.items.filter((i) => i.kind === "run").map((i) => i.id));
  const batchIds = new Set(manifest.items.filter((i) => i.kind === "batch").map((i) => i.id));
  const artifactIds = new Set(manifest.items.filter((i) => i.kind === "artifact").map((i) => i.id));
  for (const item of manifest.items) {
    if (item.kind === "artifact") {
      const split = splitArtifactId(item.id);
      const doc = split === undefined ? undefined : bytesOf.get(`artifacts/${split.artifact}/${split.version}/artifact.json`);
      if (doc === undefined) problems.push(`artifact ${item.id} is listed but missing`);
      else if (item.hash === undefined || sealHash(parseJson(doc)) !== item.hash) problems.push(`artifact ${item.id} does not match its seal hash`);
      continue;
    }
    if (item.tenant === undefined) {
      problems.push(`${item.kind} ${item.id} names no tenant`);
      continue;
    }
    if (item.kind === "key") {
      for (const f of ["history.jsonl", "record.json"]) {
        if (!bytesOf.has(`${TRUST_DIR}/${item.id}/${f}`)) problems.push(`key ${item.id}: ${f} is missing`);
      }
      continue;
    }
    if (item.kind === "batch") {
      for (const f of ["plan.json", "report.json"]) {
        if (!bytesOf.has(`${item.tenant}/batches/${item.id}/${f}`)) problems.push(`batch ${item.id}: ${f} is missing`);
      }
      continue;
    }
    const base = `${item.tenant}/runs/${item.id}/`;
    const runBytes = bytesOf.get(`${base}run.json`);
    const run = runBytes === undefined ? undefined : RunJson.safeParse(parseJson(runBytes));
    if (run === undefined || !run.success) {
      problems.push(`run ${item.id}: run.json is missing or does not parse`);
      continue;
    }
    problems.push(...runFileProblems(run.data, (rel) => bytesOf.get(`${base}${rel}`)));
    if (run.data.kind !== "discovery") {
      const parent = run.data.parent_run_id;
      if (parent !== null && !runIds.has(parent)) problems.push(`run ${item.id}: its parent ${parent} is not published`);
      const batch = run.data.batch_id;
      if (batch !== null && !batchIds.has(batch)) problems.push(`run ${item.id}: its batch ${batch} is not published`);
    }
    for (const a of artifactsNamed(run.data)) {
      if (!artifactIds.has(a)) problems.push(`run ${item.id}: its artifact ${a} is not published`);
    }
  }

  const hits = scanForCanaries([...bytesOf].map(([path, bytes]) => ({ path, bytes })), input.markers);
  if (hits.length > 0) problems.push(`canary found: ${hitText(hits)}`);
  return ok({ items: manifest.items.length, files: listed.length, problems });
}
