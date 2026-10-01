// The tag agreement table: how often a human kept the discovery model's tag on a raw action,
// per discovery model, prompt version, and tag type. Pure counting over sealed artifacts'
// `provenance.actions`. Follows design section 8 §14.3 (LLM tag agreement) and section 2 §17.3.
import type { Artifact } from "../model/artifact.js";

/** Section 8 §14.3's rule: reviewed actions needed before a tag type is `ready`. */
export const READY_MIN_REVIEWED = 50;
/** Section 8 §14.3's rule: agreement needed for `ready`. */
export const READY_MIN_AGREEMENT = 0.98;
/** Section 8 §14.3's rule: `ready` needs no human change among this many newest reviewed actions. */
export const READY_RECENT_WINDOW = 20;

/** One raw action with its model and tags. Only the LLM tag decides the tag type. */
export type TaggedAction = {
  model: string;
  /** The discovery prompt version. `null`: the artifact does not record it (see `actionsOf`). */
  prompt: string | null;
  llm_tag: string;
  /** `null`: no human has decided the tag yet, so the action is not reviewed. */
  human_tag: string | null;
};

/** One table row: the agreement for one model, prompt version, and tag type. */
export type TagRow = {
  model: string;
  prompt: string | null;
  tag_type: string;
  reviewed: number;
  agreed: number;
  /** `agreed / reviewed`; `null` with no reviewed action. */
  agreement: number | null;
  /** Human changes among the newest `READY_RECENT_WINDOW` reviewed actions. */
  recent_changes: number;
  ready: boolean;
};

/**
 * Groups actions (oldest first) and counts agreement. Unreviewed actions are skipped. Rows sort
 * by model, prompt, then tag type, so output never depends on input order across groups.
 * Why `ready` is only a flag: the build produces the table; granting is designed only (§14.3).
 */
export function tagTable(actions: readonly TaggedAction[]): TagRow[] {
  const groups = new Map<string, { row: TagRow; changes: boolean[] }>();
  for (const a of actions) {
    if (a.human_tag === null) continue;
    const key = JSON.stringify([a.model, a.prompt, a.llm_tag]);
    let g = groups.get(key);
    if (!g) {
      g = {
        row: { model: a.model, prompt: a.prompt, tag_type: a.llm_tag, reviewed: 0, agreed: 0, agreement: null, recent_changes: 0, ready: false },
        changes: [],
      };
      groups.set(key, g);
    }
    g.row.reviewed += 1;
    const changed = a.human_tag !== a.llm_tag;
    if (!changed) g.row.agreed += 1;
    g.changes.push(changed);
  }
  const rows: TagRow[] = [];
  for (const { row, changes } of groups.values()) {
    row.agreement = row.agreed / row.reviewed;
    row.recent_changes = changes.slice(-READY_RECENT_WINDOW).filter(Boolean).length;
    row.ready =
      row.reviewed >= READY_MIN_REVIEWED && row.agreement >= READY_MIN_AGREEMENT && row.recent_changes === 0;
    rows.push(row);
  }
  return rows.sort(
    (a, b) =>
      a.model.localeCompare(b.model) ||
      (a.prompt ?? "").localeCompare(b.prompt ?? "") ||
      a.tag_type.localeCompare(b.tag_type),
  );
}

/**
 * The tagged actions of one sealed artifact, in file order. The model comes from the action's
 * source run in `provenance.runs`; an action whose run is not listed gets model `unknown`.
 * Why `prompt: null`: section 2 §17.2 gives a run no prompt-version field, so the artifact
 * cannot say which prompt tagged an action.
 */
export function actionsOf(artifact: Artifact): TaggedAction[] {
  const modelOf = new Map(artifact.provenance.runs.map((r) => [r.run_id, r.model]));
  return artifact.provenance.actions.map((a) => ({
    model: modelOf.get(a.run_id) ?? "unknown",
    prompt: null,
    llm_tag: a.llm_tag,
    human_tag: a.human_tag,
  }));
}
