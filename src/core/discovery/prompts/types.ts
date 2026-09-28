// The shape every discovery prompt version has: a system prompt from the task block, and one
// message per turn. Follows design section 6 §11.1, §11.2, and §11.4 (versions live in code).
import type { Masked } from "../../../ports/masked.js";
import type { ScreenView } from "../observation.js";
import type { TaskView } from "../task-view.js";

/** How the last turn went, for the `<progress last="…">` attribute (section 6 §11.2). */
export type LastResult = "none" | "ok" | "blocked" | "bad_call" | "declined" | "failed";

/** One turn's parts, each masked. */
export type TurnView = {
  turn: number;
  limit: number;
  last: LastResult;
  /** Gate feedback or the reason a call was bad (section 6 §10.2). Null when there is none. */
  feedback: Masked<string> | null;
  history: Masked<string>;
  screen: ScreenView;
  /** True when the screenshot was withheld; the LLM is told (section 6 §8.4). */
  withheld: boolean;
};

/** One prompt version. */
export interface PromptModule {
  /** The version, like `discovery@1.0`. Frozen per run (section 6 §11.4). */
  readonly version: string;
  /** The system prompt. The same bytes every turn, so the provider can cache it (§11.3). */
  system(task: TaskView): Masked<string>;
  /** One turn's message. */
  turn(view: TurnView): Masked<string>;
}
