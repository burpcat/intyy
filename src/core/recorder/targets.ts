// Recorder step 4 (section 6 §14.2, §14.4): one target per distinct control, built straight
// from each kept action's fingerprint.
import type { Clues, Target } from "../model/artifact/targets.js";
import type { TaggedAction } from "./tags.js";

/** The role suffix table (section 6 §14.4). Takeover drafts name targets the same way. */
export const ROLE_SUFFIX: Record<string, string> = {
  button: "button",
  textbox: "box",
  combobox: "list",
  checkbox: "check",
  row: "row",
  link: "link",
};

/** One `[name#1]`-style mask token (section 4 §9.4), the opaque per-value tag a captured clue
 * may hold. Unlike a `{input.*}` or `{secret.*}` reference, it names nothing next run. */
const MASK_TOKEN = /\[[a-z]+#\d+\]/g;

/**
 * Strips mask tokens out of a captured clue's text, keeping any reference (section 6 §14.4:
 * "Clues with mask tokens are dropped... Clues with references stay"). A row that showed
 * `{input.member_id} [name#1]` keeps only `{input.member_id}` (section 2 §21's `member_row`).
 * Returns `null` when nothing but a token, or whitespace, is left.
 */
export function stripMaskTokens(text: string): string | null {
  const cleaned = text.replace(MASK_TOKEN, "").trim().replace(/\s+/g, " ");
  return cleaned === "" ? null : cleaned;
}

/** Lower-case words joined by `_`, for a target or step ID (section 6 §14.4). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "")
    .join("_");
}

/** The reference name inside a bare `{input.<name>}` string, or `null`. */
function bareInputRef(text: string): string | null {
  return /^\{input\.([a-z0-9_]+)\}$/.exec(text)?.[1] ?? null;
}

/** The word base for a target ID (section 6 §14.4): the input's own name for a row named only
 * by a reference (`member_id` becomes `member`, as `member_row`), else the clue's own words. */
function wordBase(text: string): string {
  const ref = bareInputRef(text);
  if (ref !== null) return slugify(ref.replace(/_id$/, ""));
  return slugify(text);
}

/** One collected fingerprint clue, cleaned of mask tokens, or `null` if it was captured null or
 * left nothing behind. */
function cleanClue(raw: string | null): string | null {
  // Why: section 6 §14.5, "Keeping conditions stable". An output reference stands for a value
  // that changes every run, so a clue holding one (a `read` control's own text) would never
  // match at replay. Drop it; the control keeps its role, path, and other clues.
  if (raw === null || raw.includes("{output.")) return null;
  return stripMaskTokens(raw);
}

/** The words beside a read value: its container's name with the value's `{output.*}` reference
 * taken out, like `Account No.` from `row "Account No. {output.account_number}"`. Replay finds
 * the same words by layout (`src/core/targets/screen.ts`). `null` unless the container holds the
 * reference, or when nothing stable is left. Why: with its own words dropped, a read value keeps
 * only region and path, under the vote's evidence floor (section 7 §6.5), so it is never found.
 * ponytail: assumes a "label, value" row; a label above the value needs the layout rule here too. */
function readLabel(withinRaw: string | null): string | null {
  const name = withinRaw === null ? undefined : parseWithin(withinRaw)?.name;
  if (name === undefined || !name.includes("{output.")) return null;
  return stripMaskTokens(name.replace(/\{output\.[a-z0-9_]+\}/g, ""));
}

/** One kept action's control, as the fingerprint alone can describe it (section 6 §13.1). */
type ActionControl = {
  role: string;
  name: string | null;
  label: string | null;
  text: string | null;
  region: Clues["region"] | undefined;
  crop: string | null;
  path: string;
  withinRaw: string | null;
  uniqueness: number;
};

/** Reads one action's fingerprint into an {@link ActionControl}, or `null` when it has none
 * (`press`, `navigate`, and `scroll` act with no element). */
function controlOf(a: TaggedAction): ActionControl | null {
  const fp = a.fingerprint;
  if (fp === null) return null;
  const name = cleanClue(fp.name);
  const text = cleanClue(fp.text);
  const label = cleanClue(fp.label) ?? (name === null && text === null ? readLabel(fp.within) : null);
  return {
    role: fp.role,
    name,
    label,
    text,
    region: fp.region ?? undefined,
    crop: fp.crop,
    path: fp.path,
    withinRaw: fp.within,
    uniqueness: fp.uniqueness,
  };
}

/** The container role and name inside a `within` fingerprint fact, like `form "Member Search"`. */
function parseWithin(raw: string): { role: string; name: string } | null {
  const m = /^([a-z][a-z0-9_]*) "(.*)"$/.exec(raw);
  return m?.[1] === undefined || m[2] === undefined ? null : { role: m[1], name: m[2] };
}

/** What {@link buildTargets} returns. */
export type TargetsResult = {
  /** One target per distinct control, in first-seen order; containers are added as they are met. */
  targets: readonly Target[];
  /** Each kept action's own target ID (`null` for an action with no element, like `press`). */
  targetIdOf: ReadonlyMap<TaggedAction, string | null>;
  /** Target ID to the crop file's path inside its source run folder, for an `image` clue. */
  crops: ReadonlyMap<string, string>;
};

/** One control's dedupe key: role and structure path together identify a distinct control
 * (section 6 §13.1: "Structure path... Frames included"). A fuller version would fall back to
 * the clue voter (section 7 §6) when a control's path drifts across turns; not needed yet. */
function controlKey(c: ActionControl): string {
  return `${c.role}\u0000${c.path}`;
}

/** A plain one-line description, drafted from a control's clearest clue (section 2 §13.1). */
function describe(c: ActionControl): string {
  const words = c.name ?? c.label ?? c.text;
  return words === null ? `The ${c.role} control.` : `The ${c.role} "${words}".`;
}

/** One control's clues (section 2 §13.1, §13.2). `within` is filled in by the caller once the
 * container target exists. `id` is this control's own final target ID, for its `image` clue. */
function cluesOf(c: ActionControl, id: string): Clues {
  const out: Clues = { role: c.role, path: c.path };
  if (c.name !== null) out.name = c.name;
  if (c.label !== null) out.label = c.label;
  if (c.text !== null) out.text = c.text;
  if (c.region !== undefined) out.region = c.region;
  if (c.crop !== null) out.image = `crops/${id}.png`;
  return out;
}

/** The ID a control's own words would give, before clash numbering (section 6 §14.4). */
function targetIdFor(c: ActionControl): string {
  const base = wordBase(c.name ?? c.label ?? c.text ?? "");
  const suffix = ROLE_SUFFIX[c.role] ?? c.role;
  return base === "" ? suffix : `${base}_${suffix}`;
}

/** The last path segment of a location, without its extension, as a short snake word: `/login.do`
 * → `login` (section 6 §14.4, "add the screen's name"). `""` for a root path with no such word. */
export function screenNameOf(location: string): string {
  const pathPart = location.split("?")[0] ?? location;
  const segments = pathPart.split("/").filter((s) => s !== "");
  const last = segments[segments.length - 1];
  return last === undefined ? "" : slugify(last.replace(/\.[a-z0-9]+$/i, ""));
}

/** Builds an ID, first choice, then the screen's name added, then clash numbers (section 6
 * §14.4: "add the screen's name"). `screenName` is `""` when the caller has none to add. */
export function pickId(wanted: string, used: ReadonlySet<string>, screenName = ""): string {
  if (!used.has(wanted)) return wanted;
  if (screenName !== "") {
    const withScreen = `${wanted}_${screenName}`;
    if (!used.has(withScreen)) return withScreen;
  }
  for (let n = 2; ; n++) {
    const candidate = `${wanted}_${String(n)}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Builds one target per distinct acted control (section 6 §14.4), from every kept action's
 * fingerprint. A control that is not unique on its screen (`uniqueness` > 1) and named a
 * container gets a `within` target too.
 */
export function buildTargets(actions: readonly TaggedAction[]): TargetsResult {
  const byKey = new Map<string, string>();
  const targets: Target[] = [];
  const usedIds = new Set<string>();
  const crops = new Map<string, string>();
  const targetIdOf = new Map<TaggedAction, string | null>();

  const containerId = (raw: string, screenName: string): string => {
    const parsed = parseWithin(raw);
    const key = `within\u0000${raw}`;
    const existing = byKey.get(key);
    if (existing !== undefined) return existing;
    const role = parsed?.role ?? "container";
    const name = parsed?.name ?? raw;
    const wanted = `${wordBase(name)}_${ROLE_SUFFIX[role] ?? role}`;
    const id = pickId(wanted, usedIds, screenName);
    usedIds.add(id);
    byKey.set(key, id);
    targets.push({ id, description: `The ${role} "${name}".`, clues: { role, name } });
    return id;
  };

  for (const a of actions) {
    const c = controlOf(a);
    if (c === null) {
      targetIdOf.set(a, null);
      continue;
    }
    const key = controlKey(c);
    const existing = byKey.get(key);
    if (existing !== undefined) {
      targetIdOf.set(a, existing);
      continue;
    }
    const screenName = screenNameOf(a.beforeLocation);
    const id = pickId(targetIdFor(c), usedIds, screenName);
    usedIds.add(id);
    byKey.set(key, id);
    const target: Target = { id, description: describe(c), clues: cluesOf(c, id) };
    // Why no `within` for a masked container name: the live name holds the real value, never the
    // token, so the container is never found and neither is the control (section 6 §14.4: "Clues
    // with mask tokens are dropped"). The control keeps its own clues.
    // ponytail: two same-named controls then rest on region and path; add a stable-text container
    // clue if a layout shift makes them tie.
    const masked = c.withinRaw !== null && c.withinRaw.replace(MASK_TOKEN, "") !== c.withinRaw;
    if (c.uniqueness > 1 && c.withinRaw !== null && !masked) target.within = containerId(c.withinRaw, screenName);
    targets.push(target);
    if (c.crop !== null) crops.set(id, c.crop);
    targetIdOf.set(a, id);
  }

  return { targets, targetIdOf, crops };
}
