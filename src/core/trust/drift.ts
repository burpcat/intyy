// The drift reader: plain code that reads live lines, history, and records, and finds trouble.
// Follows design section 8 §12.4 (early warnings), §13.2 (patterns), §13.3 (tying a drop to a change).
// Pure: no clock, no files. `drift-run.ts` turns findings into alert files. Skipped, by owner default:
// `clue_drift` (patch drafting is not built) and the "one app version" pattern (fixtures only, section 8 §13.2).
import { COUNTED_CLASSES, type LiveLine } from "../model/live-line.js";
import type { AlertPattern } from "../model/alert.js";
import type { HistoryLine } from "../model/score-history.js";
import type { ScoreKey, ScoreRecord } from "../model/score.js";
import { capabilityParts, keyText } from "./keys.js";
import { excludedRuns, LIVE_WINDOW } from "./live-rules.js";

/** `margin_drop`: a live margin below this fires (section 8 §12.4). */
export const MARGIN_FLOOR = 0.3;
/** `detector_drift`: this many `detector_missed` warnings for one handler (section 8 §12.4). */
export const DETECTOR_MISSES = 3;
/** `app_health`: app failures reach this share of the window's runs, in tenths (section 8 §12.4: 30%). */
export const APP_HEALTH_TENTHS = 3;
/** `app_health` needs at least this many runs in the window. Agent default: one failed run of one is not a trend. */
export const APP_HEALTH_MIN_RUNS = 5;
/** `timeout_pressure`: a clean step time above this share of its timeout, in tenths (section 8 §12.4: 80%). */
export const TIMEOUT_TENTHS = 8;
/** `timeout_pressure`: in this many runs (section 8 §12.4). */
export const TIMEOUT_RUNS = 5;
/** One tenant: the trouble needs at least this many runs. Agent default: one failure proves nothing about a tenant. */
export const TENANT_MIN_RUNS = 2;
/** Outage: this many keys of one tenant degrade within one hour (section 8 §13.2). */
export const OUTAGE_KEYS = 3;
/** One hour in milliseconds (section 8 §13.2). */
const HOUR_MS = 3_600_000;
/** Change point: counted runs needed on each side of the change. Agent default. */
export const CHANGE_MIN_RUNS = 3;
/** Change point: the live score must fall by at least this much, in hundredths. Agent default. */
export const CHANGE_DROP_HUNDREDTHS = 10;

/** What the reader knows about one key. `timeouts` are the step timeouts in force, in ms, by step ID. */
export type KeyFacts = {
  key: ScoreKey;
  record: ScoreRecord;
  history: readonly HistoryLine[];
  live: readonly LiveLine[];
  timeouts: Readonly<Record<string, number>>;
};

/** One thing the reader found. `at` is the time of its newest evidence, for `drift report --since`. */
export type Finding = {
  pattern: AlertPattern;
  tenant: string;
  /** Key text of each key involved. */
  keys: string[];
  /** Evidence run IDs. */
  runs: string[];
  at: string;
  detail: string;
  fix: string;
  /** The same finding has the same fingerprint, so the reader can raise it once. */
  fingerprint: string;
};

/** True for a line that enters the live score and is not excluded. */
function isCounted(l: LiveLine, excluded: ReadonlySet<string>): boolean {
  return COUNTED_CLASSES.includes(l.class) && !excluded.has(l.run_id);
}

/** The lines of the key's window: its last 50 counted runs and what lies between them, minus excluded runs. */
export function windowLines(live: readonly LiveLine[], excluded: ReadonlySet<string>): LiveLine[] {
  const kept = live.filter((l) => !excluded.has(l.run_id));
  const first = kept.filter((l) => COUNTED_CLASSES.includes(l.class)).slice(-LIVE_WINDOW)[0];
  return first === undefined ? kept : kept.slice(kept.indexOf(first));
}

/** The newest `at` among lines, or `""` for none. */
function newest(lines: readonly LiveLine[]): string {
  return lines.reduce((m, l) => (l.at > m ? l.at : m), "");
}

/** Builds a finding from a set of evidence lines. */
function finding(
  f: KeyFacts,
  pattern: AlertPattern,
  lines: readonly LiveLine[],
  fingerprint: string,
  detail: string,
  fix: string,
): Finding {
  return {
    pattern,
    tenant: f.key.tenant,
    keys: [keyText(f.key)],
    runs: [...new Set(lines.map((l) => l.run_id))],
    at: newest(lines),
    detail,
    fix,
    fingerprint,
  };
}

/** The lines of a window that carry a flag, matched by a test on the flag text. */
function flagged(lines: readonly LiveLine[], test: (flag: string) => boolean): LiveLine[] {
  return lines.filter((l) => (l.flags ?? []).some(test));
}

/**
 * The seven early warnings of section 8 §12.4 for one key, over its window (`clue_drift` is the one
 * that never fires here). An alert is advice: nothing here changes trust. A retired key has none.
 */
export function earlyWarnings(f: KeyFacts): Finding[] {
  if (f.record.state === "retired") return [];
  const excluded = excludedRuns(f.history);
  const win = windowLines(f.live, excluded);
  const text = keyText(f.key);
  const out: Finding[] = [];

  // margin_drop: per target, the lowest live margin against 0.30 and half the certify margin.
  const certify = f.record.certify?.scores?.margin.lowest ?? null;
  const limit = certify === null ? MARGIN_FLOOR : Math.max(MARGIN_FLOOR, certify / 2);
  const targets = [...new Set(win.flatMap((l) => Object.keys(l.margins)))].sort();
  for (const t of targets) {
    const low = Math.min(...win.map((l) => l.margins[t] ?? Infinity));
    if (!(low < limit)) continue;
    const bad = win.filter((l) => (l.margins[t] ?? Infinity) < limit);
    out.push(
      finding(
        f, "margin_drop", bad, `margin_drop:${text}:${t}`,
        `Target ${t}: lowest live margin ${low.toFixed(2)}, below ${limit.toFixed(2)}${certify === null ? "" : ` (certify lowest ${certify.toFixed(2)})`}.`,
        `Review target ${t} before it breaks. Often a tenant patch fixes it.`,
      ),
    );
  }

  // detector_drift: 3 or more detector_missed warnings for one handler.
  const handlers = new Set(win.flatMap((l) => (l.flags ?? []).filter((x) => x.startsWith("detector_missed:"))));
  for (const flag of [...handlers].sort()) {
    const hit = flagged(win, (x) => x === flag);
    const id = flag.slice("detector_missed:".length);
    if (hit.length >= DETECTOR_MISSES) {
      out.push(
        finding(
          f, "detector_drift", hit, `detector_drift:${text}:${id}`,
          `jev picked handler ${id} ${String(hit.length)} times when its detector did not match.`,
          `Fix the detector text of handler ${id} in a new pack revision, then run a regression batch.`,
        ),
      );
    }
  }

  // app_health: app failures at 30% of the window's runs.
  const seen = win.filter((l) => COUNTED_CLASSES.includes(l.class) || l.class === "app_failure");
  const app = seen.filter((l) => l.class === "app_failure");
  if (seen.length >= APP_HEALTH_MIN_RUNS && app.length * 10 >= seen.length * APP_HEALTH_TENTHS) {
    out.push(
      finding(
        f, "app_health", app, `app_health:${text}`,
        `App failures are ${String(app.length)} of the last ${String(seen.length)} runs.`,
        "Check the bank app. If it was down, exclude the affected runs with trust exclude.",
      ),
    );
  }

  // timeout_pressure: a step's clean time past 80% of its timeout in 5 runs.
  for (const [step, timeout] of Object.entries(f.timeouts).sort()) {
    const slow = win.filter((l) => (l.step_ms[step] ?? 0) * 10 > timeout * TIMEOUT_TENTHS);
    if (slow.length >= TIMEOUT_RUNS) {
      out.push(
        finding(
          f, "timeout_pressure", slow, `timeout_pressure:${text}:${step}`,
          `Step ${step} took over 80% of its ${String(timeout)} ms timeout in ${String(slow.length)} runs.`,
          `Run a full batch to tune the timeout of step ${step}, and check how fast the bank app is.`,
        ),
      );
    }
  }

  // commit_uncertain and contradiction: one finding per run, since each needs its own look.
  for (const l of flagged(win, (x) => x === "commit_uncertain")) {
    out.push(
      finding(
        f, "commit_uncertain", [l], `commit_uncertain:${text}:${l.run_id}`,
        "A run ended with its commit uncertain.",
        "Check the bank by hand for this request, since the commit may have gone through. Never retry it blindly.",
      ),
    );
  }
  for (const l of flagged(win, (x) => x === "reconciliation_contradiction")) {
    out.push(
      finding(
        f, "contradiction", [l], `contradiction:${text}:${l.run_id}`,
        "The reconciliation check found nothing after a confirmed commit.",
        "Read the run and the check's target. One of the two is wrong.",
      ),
    );
  }
  return out;
}

/** The facts grouped by tenant, in tenant order. */
function byTenant(all: readonly KeyFacts[]): Map<string, KeyFacts[]> {
  const out = new Map<string, KeyFacts[]>();
  for (const f of [...all].sort((a, b) => keyText(a.key).localeCompare(keyText(b.key)))) {
    out.set(f.key.tenant, [...(out.get(f.key.tenant) ?? []), f]);
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

/** `kvfcu/open_share_subaccount@1`: the capability major, the grouping unit of section 8 §13.2. */
function majorOf(key: ScoreKey): string {
  const p = capabilityParts(key.capability);
  return `${p.name}@${String(p.major)}`;
}

/**
 * Section 8 §13.2, "one tenant": at least two recipe failures at one step and code at one tenant,
 * while another tenant runs the same capability major on the same app version and has no such
 * failure. With no other tenant to compare, nothing fires.
 */
export function oneTenantPattern(all: readonly KeyFacts[]): Finding[] {
  type Trouble = { keys: Set<string>; lines: LiveLine[] };
  type Group = { tenants: Map<string, Trouble>; step: string; code: string };
  const groups = new Map<string, Group>();
  const ran = new Map<string, Set<string>>(); // "major|app_version" -> tenants with counted lines
  for (const f of all) {
    if (f.record.state === "retired") continue;
    const excluded = excludedRuns(f.history);
    const win = windowLines(f.live, excluded);
    const unit = `${majorOf(f.key)}|${f.key.app_version}`;
    if (win.some((l) => isCounted(l, excluded))) ran.set(unit, new Set([...(ran.get(unit) ?? []), f.key.tenant]));
    for (const l of win) {
      if (l.class !== "recipe_failure" || l.step === null || l.code === null) continue;
      const id = `${unit}|${l.step}|${l.code}`;
      const g: Group = groups.get(id) ?? { tenants: new Map<string, Trouble>(), step: l.step, code: l.code };
      const t: Trouble = g.tenants.get(f.key.tenant) ?? { keys: new Set<string>(), lines: [] };
      t.keys.add(keyText(f.key));
      t.lines.push(l);
      g.tenants.set(f.key.tenant, t);
      groups.set(id, g);
    }
  }
  const out: Finding[] = [];
  for (const [id, g] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [tenant, t] = [...g.tenants][0] ?? [];
    if (g.tenants.size !== 1 || tenant === undefined || t === undefined) continue;
    const unit = id.split("|").slice(0, 2).join("|");
    const others = [...(ran.get(unit) ?? [])].filter((x) => x !== tenant);
    if (t.lines.length < TENANT_MIN_RUNS || others.length === 0) continue;
    out.push({
      pattern: "one_tenant",
      tenant,
      keys: [...t.keys].sort(),
      runs: [...new Set(t.lines.map((l) => l.run_id))],
      at: newest(t.lines),
      detail: `${String(t.lines.length)} runs failed at step ${g.step} with ${g.code} at tenant ${tenant}. Tenant ${others.join(", ")} runs the same capability on the same app version without it.`,
      fix: "Tenant patch for target or condition drift. Tenant handler for a new interruption.",
      fingerprint: `one_tenant:${id}:${tenant}`,
    });
  }
  return out;
}

/**
 * Section 8 §13.2, "one bank, many capabilities": three or more keys of one tenant degrade by live
 * score within one hour, and app failures are most of the trouble in that hour. Likely an outage.
 */
export function outagePattern(all: readonly KeyFacts[]): Finding[] {
  const out: Finding[] = [];
  for (const [tenant, facts] of byTenant(all)) {
    const drops = facts.flatMap((f) =>
      f.history.filter((h) => h.event === "degraded" && h.by === "live_score").map((h) => ({ f, at: h.at, ms: Date.parse(h.at) })),
    ).sort((a, b) => a.ms - b.ms);
    for (const last of drops.slice().reverse()) {
      const near = drops.filter((d) => d.ms <= last.ms && d.ms > last.ms - HOUR_MS);
      const keys = [...new Set(near.map((d) => keyText(d.f.key)))].sort();
      if (keys.length < OUTAGE_KEYS) continue;
      const lines = facts
        .filter((f) => keys.includes(keyText(f.key)))
        .flatMap((f) => f.live.filter((l) => Date.parse(l.at) <= last.ms && Date.parse(l.at) > last.ms - 2 * HOUR_MS));
      const app = lines.filter((l) => l.class === "app_failure");
      const trouble = lines.filter((l) => l.class === "app_failure" || l.class === "recipe_failure");
      if (app.length * 2 <= trouble.length) continue;
      out.push({
        pattern: "outage",
        tenant,
        keys,
        runs: [...new Set(app.map((l) => l.run_id))],
        at: last.at,
        detail: `${String(keys.length)} keys of tenant ${tenant} degraded within one hour, and ${String(app.length)} of ${String(trouble.length)} failures were app failures.`,
        fix: "Likely an outage. Check the bank, then exclude the runs and restore the keys.",
        fingerprint: `outage:${tenant}:${keys.join("+")}`,
      });
      break;
    }
  }
  return out;
}

/** The fact of a live line a change point watches. */
type Dimension = "handler_set" | "engine" | "jev";

/** The counted share of clean runs, in whole units: `[counted, clean]`. */
function share(lines: readonly LiveLine[]): [number, number] {
  return [lines.length, lines.filter((l) => l.class === "clean").length];
}

/** True when the key's counted score fell across `cutAt`: at least 3 runs each side, and a drop of at least 0.10. */
function dropped(f: KeyFacts, cutAt: string): boolean {
  const excluded = excludedRuns(f.history);
  const counted = f.live.filter((l) => isCounted(l, excluded));
  const before = share(counted.filter((l) => l.at < cutAt).slice(-LIVE_WINDOW));
  const after = share(counted.filter((l) => l.at >= cutAt));
  if (before[0] < CHANGE_MIN_RUNS || after[0] < CHANGE_MIN_RUNS) return false;
  // Why cross-multiplied: before.clean / before.n - after.clean / after.n >= 0.10 without float rounding.
  return (before[1] * after[0] - after[1] * before[0]) * 100 >= CHANGE_DROP_HUNDREDTHS * before[0] * after[0];
}

/** What a change to `value` is called in an alert. A pack revision is named from the lines' `packs`. */
function nameChange(dim: Dimension, value: string | null, moves: { before: LiveLine; after: LiveLine }[]): string {
  if (dim === "handler_set") {
    const revs = new Set<string>();
    for (const { before, after } of moves) {
      const was = before.under.packs ?? {};
      for (const [scope, rev] of Object.entries(after.under.packs ?? {})) {
        if (was[scope] !== rev) revs.add(`pack ${scope} revision ${String(rev)}`);
      }
    }
    if (revs.size > 0) return [...revs].sort().join(" and ");
    return `handler set ${value === null ? "(none)" : value.slice(0, 19)}`;
  }
  return `${dim === "engine" ? "engine" : "jev"} ${value ?? "(none)"}`;
}

/**
 * Section 8 §13.3: ties a drop to a change. For each of engine, jev, and handler set: the keys of
 * one tenant that switched to a new value, and whether their counted score fell after the change
 * point (the key's first run under the value). It fires when at least half of the keys that
 * switched dropped, and no key that did not switch dropped over the same time. The alert names the
 * change: for a handler set, the pack revision (from the lines' `packs`).
 */
export function changePoints(all: readonly KeyFacts[]): Finding[] {
  const out: Finding[] = [];
  for (const [tenant, facts] of byTenant(all)) {
    for (const dim of ["handler_set", "engine", "jev"] as const) {
      const moved = new Map<string, { f: KeyFacts; cutAt: string; before: LiveLine; after: LiveLine }[]>();
      const same: KeyFacts[] = [];
      for (const f of facts) {
        if (f.record.state === "retired" || f.live.length === 0) continue;
        const final = f.live[f.live.length - 1]?.under[dim] ?? null;
        let start = f.live.length - 1;
        while (start > 0 && (f.live[start - 1]?.under[dim] ?? null) === final) start--;
        const before = f.live[start - 1];
        const after = f.live[start];
        if (start === 0 || before === undefined || after === undefined) same.push(f);
        else moved.set(String(final), [...(moved.get(String(final)) ?? []), { f, cutAt: after.at, before, after }]);
      }
      for (const [value, entries] of [...moved].sort(([a], [b]) => a.localeCompare(b))) {
        const hit = entries.filter((e) => dropped(e.f, e.cutAt));
        if (hit.length === 0 || hit.length * 2 < entries.length) continue;
        const t0 = entries.map((e) => e.cutAt).sort()[0] ?? "";
        const held = same.filter((f) => !dropped(f, t0));
        if (held.length < same.length) continue;
        const first = entries[0]?.after.under[dim] ?? null;
        const name = nameChange(dim, first, hit);
        const failures = hit.flatMap((e) =>
          e.f.live.filter((l) => l.at >= e.cutAt && l.class === "recipe_failure"),
        );
        out.push({
          pattern: "change_point",
          tenant,
          keys: hit.map((e) => keyText(e.f.key)).sort(),
          runs: [...new Set(failures.map((l) => l.run_id))],
          at: t0,
          detail: `${String(hit.length)} of ${String(entries.length)} keys that switched to ${name} dropped after the change. ${String(same.length)} key(s) that did not switch held.`,
          fix: fixFor(dim),
          fingerprint: `change_point:${tenant}:${dim}:${value}`,
        });
      }
    }
  }
  return out;
}

/** The suggested fix for a change point, by what changed. */
function fixFor(dim: Dimension): string {
  if (dim === "handler_set") return "Seal a corrected pack revision, pass a regression batch, and approve it. Or roll the pack back.";
  if (dim === "engine") return "Roll the engine back, or run a full batch under the new engine and read what changed.";
  return "Run reconciliation drills under the new jev version, tighten its thresholds, or roll the version back.";
}

/** Every finding the reader can make from these keys, in a stable order. */
export function allFindings(all: readonly KeyFacts[]): Finding[] {
  return [...all.flatMap(earlyWarnings), ...oneTenantPattern(all), ...outagePattern(all), ...changePoints(all)];
}

/** Narrows a finding list to those whose newest evidence is at or after `since` (an ISO date or time). */
export function since(findings: readonly Finding[], from: string): Finding[] {
  return findings.filter((f) => f.at >= from);
}
