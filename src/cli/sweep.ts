// The crash sweep every command runs first (section 9 §7.8). Adapts the CLI's wiring to the
// core sweep (`src/core/orchestrator/sweep.ts`, section 7 §17) and prints its report.
import { runSweep, type SweepDeps, type SweepReport, type SweptRun } from "../core/orchestrator/sweep.js";
import type { Io } from "./output.js";
import { progress } from "./output.js";

export type { SweepReport, SweptRun };

/** A sweep function. Tests pass their own to prove it runs before the command. */
export type Sweep = (tenant: string) => Promise<SweepReport>;

/** The real sweep: reads the tenant index and the run locks (section 9 §7.8). */
export function realSweep(deps: SweepDeps): Sweep {
  return (tenant) => runSweep(deps, tenant);
}

/** A do-nothing sweep: no runs, so none can have crashed. For the command-tree walk and tests
 * that do not need a real one. */
export const stubSweep: Sweep = () => Promise.resolve({ closed: 0, manual: 0, runs: [] });

/** Prints the one sweep line, only when the sweep closed a run (section 9 §7.8). */
export function reportSweep(io: Io, r: SweepReport): void {
  if (r.closed === 0) return;
  const runs = r.closed === 1 ? "run" : "runs";
  const manual = r.manual > 0 ? ` ${String(r.manual)} needs a manual reconcile.` : "";
  progress(io, `Closed ${String(r.closed)} crashed ${runs}.${manual} See \`intyy run sweep\`.`);
}
