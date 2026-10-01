// The approval screen: a pure renderer from a `Review` to text. Same record, same text.
// Follows design section 9 §9.3 (three blocks, ends with the record hash) and section 8 §10.3.
import type { Review } from "./approval.js";

/** How many runs that were not `pass` the short screen lists before it says "more". */
const SHORT_RUNS = 5;

/** A label padded to a fixed column, so values line up. */
const col = (label: string): string => label.padEnd(15);

/** Margin numbers as the example screen shows them. */
const num = (n: number | null): string => (n === null ? "n/a" : n.toFixed(2));

/** The first 8 characters of a hash, after the `sha256:` prefix. */
const short = (hash: string | null): string => (hash === null ? "unknown" : hash.replace("sha256:", "").slice(0, 8));

/** The gate line: passed, or failed with its failed rules. */
function gateLine(r: Review): string {
  if (r.gate.passed === null) return "none";
  const failed = r.gate.rules.filter((x) => !x.passed).map((x) => x.rule);
  if (r.gate.passed) return "passed";
  return failed.length === 0 ? "failed" : `failed: ${failed.join(", ")}`;
}

/** The freshness line: equal facts, or what differs. */
function freshLine(r: Review): string {
  const e = r.fresh.engine;
  const h = r.fresh.handlers;
  if (e.batch === null) return "no batch";
  const engine = e.batch === e.now ? `engine ${e.now} same` : `engine STALE ${e.batch} then, ${e.now} now`;
  const hand =
    h.batch !== null && h.batch === h.now ? `handlers ${short(h.now)} same` : `handlers STALE ${short(h.batch)} then, ${short(h.now)} now`;
  return `${engine}   ${hand}`;
}

/** The verdict counts on one line. */
function verdictLine(r: Review): string {
  if (r.verdicts === null) return "none";
  return Object.entries(r.verdicts)
    .map(([k, n]) => `${k} ${String(n)}`)
    .join("   ");
}

/**
 * Renders the approval screen. The default fits one terminal screen; `full` lists every rule,
 * every run that was not `pass`, and each link. The last line is the record hash `trust approve`
 * must quote (section 9 §9.4).
 */
export function renderReview(r: Review, full = false): string {
  const out: string[] = [];
  out.push(`KEY   ${r.key}   tenant ${r.tenant}   app ${r.appVersion}`);
  out.push(`AS    ${r.asWho ?? "no staff ID; role and sealer rules are not checked"}`);
  out.push(`STATE ${r.state}   ${r.move === "restore" ? "RESTORE" : "NEW"} ${r.change}`);
  out.push(
    `BATCH ${r.batch.id ?? "none"}   ${r.batch.kind}   ${r.batch.runs === null ? "? runs" : `${String(r.batch.runs)} ${r.batch.runs === 1 ? "run" : "runs"}`}   ` +
      (r.batch.fresh === null ? "no batch" : r.batch.fresh ? "fresh" : "STALE"),
  );
  out.push(`GATE  ${gateLine(r)}`);
  if (full) for (const x of r.gate.rules) out.push(`        ${x.rule.padEnd(10)} ${x.passed ? "passed" : "FAILED"}`);
  out.push(`FRESH ${freshLine(r)}`);
  if (r.links.length === 0) out.push("LINKS none");
  for (const [i, l] of r.links.entries()) {
    out.push(`${i === 0 ? "LINKS" : "     "} ${l.role} ${l.link}   ${l.approved === null ? "NOT APPROVED" : `approved as ${l.approved}`}`);
  }
  out.push(`VERDICTS ${verdictLine(r)}`);
  const shown = full ? r.notPass : r.notPass.slice(0, SHORT_RUNS);
  for (const x of shown) out.push(`  ${x.case_id}   run ${x.run_id}   ${x.verdict}`);
  if (shown.length < r.notPass.length) out.push(`  and ${String(r.notPass.length - shown.length)} more; see report.json, or --full`);

  out.push("");
  out.push("BLOCKS APPROVAL");
  if (r.blocks.length === 0) out.push("  none");
  for (const b of r.blocks) out.push(`  ${b.code}   ${b.detail}`);

  out.push("");
  out.push("NEEDS YOUR NOTE");
  if (r.fragile.length === 0) out.push("  none");
  for (const f of r.fragile) {
    out.push(`  ${f.step}   margin ${num(f.lowest)} (median ${num(f.median)})   winner ${num(f.score)}   differing: not recorded   --ack ${f.step}`);
  }

  out.push("");
  out.push("READ BEFORE YOU APPROVE");
  out.push(`  ${col("lowered flags")}${r.lowered.length === 0 ? "none" : r.lowered.join("; ")}`);
  out.push(`  ${col("coverage gaps")}${r.gaps.length === 0 ? "none" : r.gaps.join("; ")}`);
  out.push(`  ${col("stability")}${r.stability}`);
  out.push(`  ${col("timeouts")}${r.timeouts}`);
  // Why: section 8 §14.2. The jev line and the autonomy state come from the batch report and the record. Burn-in runs and sealing warnings still have no data source.
  out.push(`  ${col("jev")}${r.jev}   autonomy: ${r.autonomy}`);
  out.push(`  ${col("burn-in")}not tracked yet (M11)`);
  out.push(`  ${col("sealing")}no open warnings recorded`);
  out.push(`RECORD ${r.record}`);
  return out.join("\n");
}
