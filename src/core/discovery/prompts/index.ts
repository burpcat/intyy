// Every discovery prompt version, by name. A run spec names one; the run freezes it.
// Follows design section 6 §11.4 (versions live in code, frozen per run).
import { discovery_1_0 } from "./discovery-1.0.js";
import { discovery_1_1 } from "./discovery-1.1.js";
import type { PromptModule } from "./types.js";

/** Prompt versions by name, like `discovery@1.0`. */
export const PROMPTS: Readonly<Record<string, PromptModule>> = {
  [discovery_1_0.version]: discovery_1_0,
  [discovery_1_1.version]: discovery_1_1,
};
