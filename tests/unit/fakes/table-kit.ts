// Shared helpers for the table fake tests: a recorder that logs into an array, and small valid
// jev and reviewer inputs. Made-up values only. Design section 5 §10.9 and section 9 §5.3.
import type { Masked } from "../../../src/ports/masked.js";
import type {
  CallRecorder,
  JevReconcileInput,
  JevTroubleInput,
  ReviewerInput,
} from "../../../src/ports/models.js";

/** One recorded part. */
export type Recorded = { part: "request" | "reply"; text: string };

/** A recorder that pushes into `log`. With `failOn`, that part's write fails (returns false). */
export function recorder(log: Recorded[], failOn?: "request" | "reply"): CallRecorder {
  return (part, bytes) => {
    if (part === failOn) return Promise.resolve(false);
    log.push({ part, text: new TextDecoder().decode(bytes) });
    return Promise.resolve(true);
  };
}

/** Marks a test value as masked. Tests only; redaction owns the real mark. */
function masked<T>(v: T): Masked<T> {
  return v as Masked<T>;
}

const step = {
  id: "open_form",
  intent: "Open the form",
  action: "click",
  risk: "idempotent",
  phase: "checkpoint",
} as const;
const expected = {
  condition: "form_shown",
  description: "The form shows",
  trace: [{ path: "form_shown", check: "element_visible", passed: false }],
};

/** A trouble input for step `id`; `tag` makes the bytes (and so the hash) differ. */
export function troubleInput(id = "open_form", tag = "a"): Masked<JevTroubleInput> {
  return masked({
    schema: "intyy.jev.step/1.0",
    step: { ...step, id },
    expected,
    last_good: null,
    screen: {
      location: `/page/${tag}`,
      truncated: false,
      elements: [{ role: "button", name: "Close" }],
    },
    outcomes: [],
    handlers: [],
    tied: [],
  });
}

/** A reconciliation input for commit step `id`. */
export function reconcileInput(id = "click_confirm", tag = "a"): Masked<JevReconcileInput> {
  return masked({
    schema: "intyy.jev.reconcile/1.0",
    parent: {
      capability: "app/cap@1",
      commit_step: { id, intent: "Confirm" },
      correlation: "notes",
      last_screen: { location: `/page/${tag}`, elements: [] },
    },
    check: {
      capability: "app/check@1",
      status: "failed",
      outcome: null,
      failure: null,
      final_screen: { location: "/list", elements: [] },
    },
    not_found_outcomes: ["not_found"],
  });
}

/** A reviewer input for step `id`. */
export function reviewerInput(id = "open_form", tag = "a"): Masked<ReviewerInput> {
  return masked({
    schema: "intyy.reviewer.step/1.0",
    step: { ...step, id },
    expected,
    last_good: null,
    screen: {
      location: `/page/${tag}`,
      truncated: false,
      elements: [{ id: "e1", role: "button", name: "Close" }],
    },
    jev: null,
    inputs: [],
    allowed: { actions: ["click"], keys: ["Escape"], paths: ["/page"] },
    commit: "not_sent",
    screenshot: null,
  });
}
