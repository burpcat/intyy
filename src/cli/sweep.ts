// The crash sweep every command runs first. M01 ships a stub that finds no runs.
// Follows design section 9 §7.8. The real sweep reads the tenant index and the run locks.
import type { Io } from "./output.js";
import { progress } from "./output.js";

/** What a sweep did. */
export type SweepReport = { closed: number; manual: number };

/** A sweep function. Tests pass their own to prove it runs before the command. */
export type Sweep = (tenant: string) => Promise<SweepReport>;

/** The M01 stub: no runs exist yet, so none can have crashed. */
export const stubSweep: Sweep = () => Promise.resolve({ closed: 0, manual: 0 });

/** Prints the one sweep line, only when the sweep closed a run (section 9 §7.8). */
export function reportSweep(io: Io, r: SweepReport): void {
  if (r.closed === 0) return;
  const runs = r.closed === 1 ? "run" : "runs";
  const manual = r.manual > 0 ? ` ${String(r.manual)} needs a manual reconcile.` : "";
  progress(io, `Closed ${String(r.closed)} crashed ${runs}.${manual} See \`intyy run sweep\`.`);
}
