// Every noun's commands, in the order `intyy --help` lists them.
// Follows design section 9 §7.1 (grammar) and build plan section 10 §5.2 (commands/<noun>.ts).
import type { Register } from "../program.js";
import { registerPolicy } from "./policy.js";
import { registerSettings } from "./settings.js";
import { registerSpec } from "./spec.js";
import { registerStaff } from "./staff.js";

/** The real command list. `main.ts` passes it to `run`. */
export const commands: readonly Register[] = [
  registerPolicy,
  registerSettings,
  registerSpec,
  registerStaff,
];
