// The approval rules: what blocks an approval, what needs a written note, and what the approver
// reads. Pure functions of facts the CLI gathers; no files, no clock.
// Follows design section 8 §10.3 (what the approver sees), §10.4 (rules to approve), §10.8
// (restore), and section 9 §9.3 (the three blocks of the screen).
import type { Artifact, Decision } from "../model/artifact.js";
import { hashJson } from "../model/canonical.js";
import type { BatchReport } from "../model/batch-report.js";
import type { ScoreKey, ScoreRecord, TrustState } from "../model/score.js";
import { IndexLine } from "../model/store-index.js";
import type { Role } from "../model/staff.js";
import { capabilityParts, keyText } from "./keys.js";
import { recordHash } from "./rebuild.js";
import { decide } from "./state.js";

/** A session or check link of the artifact, and the approved key that serves it in this context (`null`: none). */
export type LinkFact = { role: "session" | "check"; link: string; approved: string | null };

/** Everything the rules read. The CLI gathers it; tests build it by hand. */
export type ReviewFacts = {
  key: ScoreKey;
  /** The record now, or the synthetic draft when the key has no files. */
  record: ScoreRecord;
  /** The batch the approver names; `null` when none was named and the record has no full batch. */
  batchId: string | null;
  /** That batch's `report.json`; `null` when the file is missing or unreadable. */
  report: BatchReport | null;
  /** What a live run would freeze now (section 8 §10.4, rule 2). `handlerSet` is `null` when unknown. */
  now: { engine: string; handlerSet: string | null };
  /** False when the key's artifact is not sealed in this library. */
  artifactSealed: boolean;
  links: readonly LinkFact[];
  /** Who sealed the artifact, from the artifact index (`null`: no `sealed` line). */
  sealer: string | null;
  /** The person reading or deciding. `null`: no staff ID, so role and sealer rules are not checked. */
  who: { staff: string; roles: readonly Role[] } | null;
  /** The artifact's recorded human decisions, for the lowered risk flags. */
  decisions: readonly Decision[];
  /** Key texts of the context's other approved keys for this capability and major. */
  prior: readonly string[];
};

/** The move a review is for: a degraded key is restored, anything else is approved. */
export type ApprovalMove = "approve" | "restore";

/** Why an approval is blocked. */
export type BlockCode =
  | "no_full_batch"
  | "not_latest_batch"
  | "not_approval_grade"
  | "report_missing"
  | "report_changed"
  | "gate_failed"
  | "stale"
  | "not_new_batch"
  | "no_artifact"
  | "link_not_approved"
  | "role"
  | "four_eyes"
  | "illegal_move"
  | "needs_staff";

/** One thing that blocks approval, with a plain detail. */
export type Block = { code: BlockCode; detail: string };

/** The move a key's state calls for. */
export function moveFor(state: TrustState): ApprovalMove {
  return state === "degraded" ? "restore" : "approve";
}

/** The steps that need a written note: the full batch's fragile steps (section 8 §10.4, rule 4). */
export function fragileSteps(record: ScoreRecord): string[] {
  return record.certify?.scores?.fragile ?? [];
}

/** The six rules that failed, from a report. Empty when the report has none. */
function failedRules(report: BatchReport): string[] {
  return Object.entries(report.gate.rules ?? {})
    .filter(([, passed]) => !passed)
    .map(([rule]) => rule);
}

/** The batch rules: it exists, is the latest full batch, passed the gate, and is fresh (section 8 §10.4, rules 1 and 2). */
function batchBlocks(f: ReviewFacts, move: ApprovalMove): Block[] {
  const c = f.record.certify;
  // Why: a record's `certify` holds only the latest non-drill full batch (rebuild), so a quick,
  // case, rerun, or drill batch can never be the one approved (section 9 §9.1, section 8 §7.1).
  if (c === null) return [{ code: "no_full_batch", detail: "no full batch has run for this key; run intyy certify" }];
  if (f.batchId !== c.batch) {
    return [
      {
        code: "not_latest_batch",
        detail: `batch ${f.batchId ?? "(none)"} is not the key's latest full batch, ${c.batch}`,
      },
    ];
  }
  const out: Block[] = [];
  if (f.report === null) {
    out.push({ code: "report_missing", detail: `report.json of ${c.batch} is missing or unreadable` });
  } else {
    if (hashJson(f.report) !== c.report_hash) {
      out.push({ code: "report_changed", detail: `report.json of ${c.batch} no longer matches its history line` });
    }
    if (f.report.kind !== "full" || f.report.drill === true || f.report.models_off === true) {
      out.push({ code: "not_approval_grade", detail: `${c.batch} is not a full batch with models on and the declared instance` });
    }
  }
  const failed = f.report === null ? [] : failedRules(f.report);
  if (c.gate !== "passed" || (f.report !== null && !f.report.gate.passed)) {
    out.push({
      code: "gate_failed",
      detail: failed.length === 0 ? "the batch failed its gate" : `the batch failed its gate: ${failed.join(", ")}`,
    });
  }
  if (c.under.engine !== f.now.engine) {
    out.push({ code: "stale", detail: `engine ${c.under.engine} ran the batch; a live run would use ${f.now.engine}` });
  }
  if (c.under.handler_set === null || c.under.handler_set !== f.now.handlerSet) {
    out.push({ code: "stale", detail: "the handler set changed since the batch; run it again" });
  }
  // Why: section 8 §10.8, "a new fresh full batch". A batch from before the demotion proves nothing new.
  if (move === "restore" && f.record.state_since !== null && c.at <= f.record.state_since) {
    out.push({ code: "not_new_batch", detail: `${c.batch} is not newer than the demotion; run a new full batch` });
  }
  return out;
}

/**
 * Everything that blocks the move, in order: the batch, then (approve only) the artifact, links,
 * and four eyes, then the role and state through the state machine (section 9 §9.3, "Blocks
 * approval"). Restore checks the batch and the machine only: section 8 §10.8 names no link or
 * sealer rule for it, and a run-start check 7 still guards the links.
 */
export function approvalBlocks(f: ReviewFacts, move: ApprovalMove = moveFor(f.record.state)): Block[] {
  const out = batchBlocks(f, move);
  if (move === "approve") {
    if (!f.artifactSealed) out.push({ code: "no_artifact", detail: `${f.key.capability} is not sealed in this library` });
    for (const l of f.links) {
      if (l.approved === null) {
        out.push({
          code: "link_not_approved",
          detail: `${l.role} capability ${l.link} has no approved key in tenant ${f.key.tenant}, app ${f.key.app_version}`,
        });
      }
    }
    if (f.who !== null && f.artifactSealed) {
      // Why: section 8 §10.2. Nobody trusts their own work into production. No `sealed` line fails safe.
      if (f.sealer === null) out.push({ code: "four_eyes", detail: "the artifact index names no sealer" });
      else if (f.sealer === f.who.staff) out.push({ code: "four_eyes", detail: `${f.who.staff} sealed this artifact and cannot approve it` });
    }
  }
  if (f.who !== null) {
    const d = decide(f.record.state, move, f.who.staff, f.who.roles);
    if (!d.ok) out.push({ code: d.failure, detail: d.detail ?? d.failure });
  }
  return out;
}

/** Why an approval or restore command refuses. `record_changed` and `needs_ack` join the blocks. */
export type Refusal = { code: BlockCode | "record_changed" | "needs_ack"; detail: string };

/**
 * Every refusal for `trust approve` or `trust restore`: a changed record first (section 8 §10.5:
 * nobody decides on a state they did not see), then the blocks, then fragile steps with no `--ack`
 * (approve only: section 8 §10.4, rule 4). Empty means go ahead.
 */
export function refusals(
  f: ReviewFacts,
  move: ApprovalMove,
  quoted: string,
  acknowledged: readonly string[],
): Refusal[] {
  const now = recordHash(f.record);
  if (quoted !== now) {
    return [
      {
        code: "record_changed",
        detail: `the record is ${now} now (state ${f.record.state}, latest full batch ${f.record.certify?.batch ?? "none"}), not ${quoted}; run intyy trust review again`,
      },
    ];
  }
  const out: Refusal[] = approvalBlocks(f, move);
  if (move === "approve") {
    const missing = fragileSteps(f.record).filter((s) => !acknowledged.includes(s));
    if (missing.length > 0) {
      out.push({ code: "needs_ack", detail: `acknowledge each fragile step: ${missing.map((s) => `--ack ${s}`).join(" ")}` });
    }
  }
  return out;
}

/** The context's other approved keys for the same capability name and major: what approval retires (section 8 §10.5, step 2). */
export function priorApproved(records: readonly ScoreRecord[], key: ScoreKey): ScoreKey[] {
  const me = capabilityParts(key.capability);
  return records
    .filter((r) => {
      const p = capabilityParts(r.key.capability);
      return (
        r.state === "approved" &&
        r.key.tenant === key.tenant &&
        r.key.app_version === key.app_version &&
        p.name === me.name &&
        p.major === me.major &&
        keyText(r.key) !== keyText(key)
      );
    })
    .map((r) => r.key);
}

/** The approved key that serves a link like `kvfcu/sign_in@1` in this context, as key text, or `null` (section 8 §10.10). */
export function approvedFor(
  records: readonly ScoreRecord[],
  link: string,
  tenant: string,
  appVersion: string,
): string | null {
  const at = link.lastIndexOf("@");
  const name = link.slice(0, at);
  const major = Number(link.slice(at + 1));
  const hit = records.find((r) => {
    const p = capabilityParts(r.key.capability);
    return (
      r.state === "approved" &&
      r.key.tenant === tenant &&
      r.key.app_version === appVersion &&
      p.name === name &&
      p.major === major
    );
  });
  return hit === undefined ? null : keyText(hit.key);
}

/**
 * The links an artifact needs approved (section 8 §10.4, rule 3): its session capability, and for
 * a `commits` artifact the reconciliation check capability. A waiver needs no check, so it adds no link.
 */
export function linkFacts(
  artifact: Artifact,
  records: readonly ScoreRecord[],
  tenant: string,
  appVersion: string,
): LinkFact[] {
  const out: LinkFact[] = [];
  const session = artifact.runs_on.session;
  if (session !== null) out.push({ role: "session", link: session, approved: approvedFor(records, session, tenant, appVersion) });
  const check = artifact.contract.effect === "commits" ? artifact.recovery?.reconciliation?.check?.capability : undefined;
  if (check !== undefined) out.push({ role: "check", link: check, approved: approvedFor(records, check, tenant, appVersion) });
  return out;
}

/** Who sealed `<artifactId>@<version>`: the `by` of its `sealed` line in the artifact index text, or `null` (section 8 §10.2). */
export function sealerOf(indexText: string, artifactId: string, version: string): string | null {
  let by: string | null = null;
  for (const line of indexText.split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = IndexLine.safeParse(raw);
    if (parsed.success && parsed.data.event === "sealed" && parsed.data.id === artifactId && parsed.data.rev === version) {
      by = parsed.data.by;
    }
  }
  return by;
}

/** One fragile step with its margins from the report (`null` when the report has none). */
export type FragileRow = { step: string; lowest: number | null; median: number | null; score: number | null };

/** What the screen shows, as plain data. `renderReview` turns it into text. */
export type Review = {
  key: string;
  tenant: string;
  appVersion: string;
  move: ApprovalMove;
  state: TrustState;
  /** What changed since the context's approved key (section 8 §10.3, item 1). */
  change: string;
  /** The staff ID looking, or `null` when role and sealer rules were not checked. */
  asWho: string | null;
  batch: { id: string | null; kind: string; runs: number | null; fresh: boolean | null };
  gate: { passed: boolean | null; rules: { rule: string; passed: boolean }[] };
  fresh: { engine: { batch: string | null; now: string }; handlers: { batch: string | null; now: string | null } };
  links: readonly LinkFact[];
  verdicts: Record<string, number> | null;
  notPass: { case_id: string; run_id: string; verdict: string }[];
  blocks: Block[];
  fragile: FragileRow[];
  gaps: string[];
  stability: string;
  timeouts: string;
  lowered: string[];
  /** The record hash `trust approve` must quote. */
  record: string;
};

/** Describes what approval changes in the context (section 8 §10.3, item 1). */
function describeChange(f: ReviewFacts, move: ApprovalMove): string {
  if (move === "restore") return "restores a degraded key";
  if (f.record.state === "approved") return "re-approves the approved key";
  const other = f.prior[0];
  if (other === undefined) return "first approval in this context";
  const [base = other, patch] = other.split("+p");
  const what = [
    capabilityParts(base).version === capabilityParts(f.key.capability).version ? "" : "version",
    (patch === undefined ? null : Number(patch)) === f.key.patch_revision ? "" : "patch",
  ]
    .filter((s) => s !== "")
    .join(" and ");
  return `replaces ${other} (${what})`;
}

/** The lowered risk flags with both staff IDs (section 8 §10.3, item 10): each `risk_second_look` and the decision it confirms. */
function loweredFlags(decisions: readonly Decision[]): string[] {
  return decisions
    .filter((d) => d.what === "risk_second_look")
    .map((d) => {
      const risk = decisions.findLast((r) => r.what === "risk" && r.subject === d.subject);
      return `${d.subject}: ${risk?.value ?? "?"}   ${risk?.by ?? "?"}, second look ${d.by}`;
    });
}

/** `click_search 10 s, click_submit 12.5 s`: step IDs with their values in seconds. */
function secondsList(values: Readonly<Record<string, number>>): string {
  return Object.entries(values).map(([step, ms]) => `${step} ${String(ms / 1000)} s`).join(", ");
}

/**
 * The timeouts line (section 9 §9.3's example): what approval installs (the values the batch ran
 * with, or the defaults), and the candidates the batch proposes for the next batch to test.
 */
function timeoutsLine(t: BatchReport["timeouts"]): string {
  if (t === undefined) return "installs defaults; no candidates";
  const installs = Object.keys(t.ran_with).length === 0 ? "installs defaults" : `installs ${secondsList(t.ran_with)}`;
  if (t.scaled === true) return `${installs}; no candidates, the batch ran with shortened delays`;
  return Object.keys(t.proposed).length === 0 ? `${installs}; no candidates` : `${installs}; candidates ${secondsList(t.proposed)}`;
}

/**
 * The stability line (section 9 §9.3's example): per level the pass share and any unexplained,
 * assisted, or wrong runs, then the worst twin mismatch. `not run` when the batch had none.
 */
function stabilityLine(curve: BatchReport["stability"]): string {
  if (curve === null || curve === undefined || curve.length === 0) return "not run";
  const levels = curve.map((l) => {
    const extra = [
      l.unexplained > 0 ? `${String(Math.round(l.unexplained * l.runs))} unexplained` : "",
      l.assisted > 0 ? `${String(Math.round(l.assisted * l.runs))} assisted` : "",
      l.wrong > 0 ? `${String(l.wrong)} WRONG` : "",
    ].filter((x) => x !== "");
    return `${l.entropy.toFixed(2)}: ${String(Math.round(l.pass * 100))}% pass${extra.map((x) => `, ${x}`).join("")}`;
  });
  const worst = curve.reduce((a, b) => (b.twin_mismatch > a.twin_mismatch ? b : a));
  return `${levels.join("   ")}   twins ${String(worst.twin_mismatch)}${worst.twin_mismatch > 0 ? ` at ${worst.entropy.toFixed(2)}` : ""}`;
}

/** Builds the screen's data from the facts. `batchId` falls back to the record's latest full batch. */
export function buildReview(f: ReviewFacts): Review {
  const move = moveFor(f.record.state);
  const c = f.record.certify;
  const report = f.report;
  const blocks = approvalBlocks(f, move);
  const targets = report?.margin?.targets ?? {};
  const rules = Object.entries(report?.gate.rules ?? {}).map(([rule, passed]) => ({ rule, passed }));
  const staleFacts = c !== null && (c.under.engine !== f.now.engine || c.under.handler_set === null || c.under.handler_set !== f.now.handlerSet);
  return {
    key: keyText(f.key),
    tenant: f.key.tenant,
    appVersion: f.key.app_version,
    move,
    state: f.record.state,
    change: describeChange(f, move),
    asWho: f.who?.staff ?? null,
    batch: {
      id: f.batchId,
      kind: report?.kind ?? (c === null ? "none" : "full"),
      runs: report?.cases.length ?? null,
      fresh: c === null ? null : !staleFacts,
    },
    gate: { passed: c === null ? null : c.gate === "passed" && report?.gate.passed !== false, rules },
    fresh: {
      engine: { batch: c?.under.engine ?? null, now: f.now.engine },
      handlers: { batch: c?.under.handler_set ?? null, now: f.now.handlerSet },
    },
    links: f.links,
    verdicts: report?.verdicts ?? c?.scores?.verdicts ?? null,
    notPass: (report?.cases ?? [])
      .filter((x) => x.verdict !== "pass")
      .map((x) => ({ case_id: x.case_id, run_id: x.run_id, verdict: x.verdict })),
    blocks,
    fragile: fragileSteps(f.record).map((step) => ({
      step,
      lowest: targets[step]?.lowest ?? null,
      median: targets[step]?.median ?? null,
      score: targets[step]?.score_low ?? null,
    })),
    gaps: report?.coverage_gaps ?? [],
    stability: stabilityLine(report?.stability),
    timeouts: timeoutsLine(report?.timeouts),
    lowered: loweredFlags(f.decisions),
    record: recordHash(f.record),
  };
}
