// Human action capture, core side: the bot's own action windows (who touched the page, the bot or
// a person), the log lines a human action leaves, and the check for a human who sent the commit.
// Follows design section 7 §14 (capture, values, bot or human, commit click, native dialogs),
// section 4 §7.10 (humans during a takeover) and §8.10 (what typed text leaves in the log).
import type { Clock } from "../../ports/clock.js";
import type { ElementFingerprint, Eyes, HumanInput, SurfaceElement, Viewport } from "../../ports/surface.js";
import type { Target } from "../model/artifact/targets.js";
import type { LogLine } from "../orchestrator/run-log.js";
import type { Gate, GateResult } from "../safety/gate/gate.js";
import type { Redactor } from "../safety/redaction/redactor.js";
import { vote } from "../targets/vote.js";
import type { Lease } from "./lease.js";

/** Section 7 §14.3: the bot's window stays open this long after its action ends. */
export const BOT_WINDOW_AFTER_MS = 300;

/** Section 7 §14.4: a human click scoring this much against the commit target sent the commit. */
export const COMMIT_CLICK_SCORE = 0.7;

/** How many closed windows to remember. A bot `type` is reported at blur, some actions later. */
const KEEP_WINDOWS = 30;

/** The path of the control an input touched, or `null` when it names none (a navigation). */
function inputPath(input: HumanInput): string | null {
  const a = input.action;
  return a.type === "navigate" ? null : a.type === "press" ? (a.target?.clues.path ?? null) : a.target.clues.path;
}

/**
 * True when `event` is the bot's target or sits inside it. A click lands on the control's
 * inner text, so a path below the target's path counts. A `null` on either side matches
 * anything: a key press with no target, or a bot action with none.
 */
export function pathMatches(bot: string | null, event: string | null): boolean {
  if (bot === null || event === null) return true;
  return event === bot || event.startsWith(`${bot} > `) || bot.startsWith(`${event} > `);
}

/**
 * The engine's own action windows (section 7 §14.3): from just before the hands act until
 * {@link BOT_WINDOW_AFTER_MS} after. An input on the bot's target inside a window is the bot's.
 * Every other input is a person's. The gate calls `begin` and `end` around each action.
 */
export class BotWindows {
  readonly #windows: { start: number; end: number | null; path: string | null }[] = [];

  /** `now` returns ms since the epoch, from the clock port. */
  constructor(private readonly now: () => number) {}

  /** The hands are about to act on `path` (or on nothing, with `null`). */
  begin(path: string | null): void {
    this.#windows.push({ start: this.now(), end: null, path });
    if (this.#windows.length > KEEP_WINDOWS) this.#windows.shift();
  }

  /** The last action ended. Its window stays open for 300 ms more. */
  end(): void {
    const open = this.#windows.findLast((w) => w.end === null);
    if (open !== undefined) open.end = this.now();
  }

  /** True when an input at `at` (ms) on `path` belongs to the bot. */
  owns(at: number, path: string | null): boolean {
    return this.#windows.some(
      (w) =>
        at >= w.start &&
        (w.end === null || at <= w.end + BOT_WINDOW_AFTER_MS) &&
        pathMatches(w.path, path),
    );
  }
}

/** The fingerprint of an element the eyes see, with no field value (section 7 §14.1). */
export function fingerprintOf(el: SurfaceElement): ElementFingerprint {
  const out: ElementFingerprint = { role: el.role, roleGroup: el.roleGroup, clues: el.clues, box: el.box };
  if (el.tooltip !== undefined) out.tooltip = el.tooltip;
  if (el.href !== undefined) out.href = el.href;
  if (el.form !== undefined) out.form = el.form;
  if (el.field !== undefined) out.fieldKind = el.field.kind;
  return out;
}

/**
 * True when a human's control scores 0.70 or more against the commit step's target clues, by the
 * clue voter (section 7 §14.4, §6). The control is the only candidate. `within` is dropped: the
 * parent's own vote needs a whole screen, and only this control's own clues matter here.
 */
export function meetsCommitTarget(
  target: Target,
  fp: ElementFingerprint,
  viewport: Viewport,
  refs: ReadonlyMap<string, string> | undefined,
): boolean {
  const flat: Target = { ...target };
  delete flat.within;
  const el = {
    id: "0",
    role: fp.role,
    roleGroup: fp.roleGroup,
    path: fp.clues.path,
    visible: true,
    enabled: true,
    ...(fp.clues.name === undefined ? {} : { name: fp.clues.name }),
    ...(fp.clues.label === undefined ? {} : { label: fp.clues.label }),
    ...(fp.clues.text === undefined ? {} : { text: fp.clues.text }),
    ...(fp.box === null
      ? {}
      : {
          region: {
            x: fp.box.x / viewport.width,
            y: fp.box.y / viewport.height,
            w: fp.box.width / viewport.width,
            h: fp.box.height / viewport.height,
          },
        }),
  };
  const v = vote(flat, { location: "", elements: [el] }, new Map(), refs);
  return (v.facts.score ?? 0) >= COMMIT_CLICK_SCORE && v.facts.winner !== null;
}

/** The commit step the capture watches for a human's send (section 7 §14.4). */
export type CommitWatch = {
  /** The commit step's target, from the artifact. */
  target: Target;
  /** True while the commit state is `not_sent`. */
  notSent(): boolean;
  /** A human sent it. `at` is the event's time, as an ISO string. */
  humanSent(at: string): void;
};

/** What `HumanCapture` needs. */
export type CaptureDeps = {
  gate: Gate;
  /** Reads the screen, for the operator's dialog answer. */
  eyes: Eyes;
  lease: Lease;
  redactor: Redactor;
  windows: BotWindows;
  clock: Clock;
  viewport: Viewport;
  /** The input values, for `{input.*}` clues (section 7 §6.3). Never logged. */
  refs: ReadonlyMap<string, string> | undefined;
  /** The commit to watch, or `null` for a run with none. */
  commit: CommitWatch | null;
  /** The step the run is on now. */
  step: () => string | null;
  /** Writes one log line. The writer masks it. */
  log: (line: LogLine) => void;
  signal?: AbortSignal;
};

/**
 * Turns human input into a gate line and an `action` line with `by: human` (section 7 §14.1,
 * section 3 §6.4), and finds the human who sent the commit (§14.4). Values are masked three ways
 * (§14.2, section 4 §8.10): `[secret]`, a known input's reference, or `[human_text]`.
 */
export class HumanCapture {
  #actions = 0;

  constructor(private readonly d: CaptureDeps) {}

  /** How many human actions were logged so far. The handback reports the count per takeover
   * (section 7 §16, `interventions[].human_actions`). */
  get actions(): number {
    return this.#actions;
  }

  /** True when the input is the bot's own (section 7 §14.3). */
  isBot(input: HumanInput): boolean {
    return this.d.windows.owns(input.at, inputPath(input));
  }

  /** Logs a person's input after it happened. The gate classes it `observed`. */
  record(input: HumanInput): void {
    this.#after(input, this.d.gate.observeHuman(input, this.d.step()));
  }

  /**
   * The operator answered a native box through the CLI (section 7 §14.5). The engine clicks its
   * Accept or Dismiss for them: a human-actor click, through the gate, with the staff ID as the
   * approver. Returns false when no such button is on screen.
   */
  async answerDialog(staff: string, answer: "accept" | "dismiss"): Promise<boolean> {
    const seen = await this.d.eyes.observe(this.d.signal);
    const want = `native:dialog > ${answer}`;
    const el = seen.ok ? seen.value.elements.find((e) => e.clues.path === want) : undefined;
    if (!seen.ok || el === undefined) {
      this.d.log({
        event: "warning",
        step: this.d.step(),
        by: "engine",
        data: { code: "dialog_answer_not_applied", detail: "no native box with that button was open" },
      });
      return false;
    }
    const acted = await this.d.gate.act(
      {
        actor: "human",
        lease: this.d.lease.botToken(),
        action: { type: "click", target: el.ref },
        step: this.d.step(),
        approval: { by: staff },
      },
      this.d.signal,
    );
    if (!acted.ok || acted.value.act?.dispatched === false) return false;
    const input: HumanInput = {
      at: this.d.clock.now().getTime(),
      url: seen.value.url,
      action: { type: "click", target: fingerprintOf(el) },
    };
    this.#after(input, acted.value);
    return true;
  }

  /** The log lines and the commit check that follow one human action. */
  #after(input: HumanInput, seen: GateResult): void {
    const step = this.d.step();
    this.#actions += 1;
    this.d.log({ event: "action", step, by: "human", data: this.#data(input) });
    const sent = this.#sentCommit(input);
    // Why also on a commit click: section 7 §14.4 sends it to the commit state, and section 4
    // §7.10 asks for the warning on every irreversible human action.
    if (seen.risk === "irreversible" || sent) {
      this.d.log({
        event: "warning",
        step,
        by: "engine",
        data: { code: "human_irreversible_action", detail: "a person did something the rules class as irreversible" },
      });
    }
    if (sent) {
      const at = this.d.clock.now();
      at.setTime(input.at); // Why `setTime`: core never makes a Date.
      this.d.commit?.humanSent(at.toISOString());
    }
  }

  /** True when this input is a human click, Enter, or box answer that sent the commit. */
  #sentCommit(input: HumanInput): boolean {
    const c = this.d.commit;
    if (c === null || !c.notSent()) return false;
    const a = input.action;
    const hit = (fp: ElementFingerprint | null): boolean =>
      fp !== null && meetsCommitTarget(c.target, fp, this.d.viewport, this.d.refs);
    if (a.type === "click") return hit(a.target);
    if (a.type === "press" && a.key === "Enter") return hit(a.target) || hit(a.submit);
    return false;
  }

  /** The `data` of an `action` line (section 3 §6.4): what the person did, masked three ways. */
  #data(input: HumanInput): Record<string, unknown> {
    const a = input.action;
    const r = this.d.redactor;
    const fp = a.type === "navigate" ? null : a.target;
    const view = this.d.viewport;
    return {
      type: a.type,
      staff_id: this.d.lease.staffId,
      // Why `humanText`: section 4 §8.10, typed text is never logged raw, even when harmless.
      value: a.type === "type" ? r.humanText(a.value) : a.type === "navigate" ? r.text(a.to) : null,
      option: a.type === "select" ? r.text(a.option) : null,
      checked: a.type === "set_checked" ? a.checked : null,
      key: a.type === "press" ? a.key : null,
      result: "ok",
      dispatched: true,
      transport: null,
      fingerprint:
        fp === null
          ? null
          : {
              role: fp.role,
              // Why: section 4 §9.10, a name is logged only for a button-like control.
              name: fp.roleGroup === "button_like" ? (fp.clues.name ?? null) : null,
              label: fp.roleGroup === "button_like" ? (fp.clues.label ?? null) : null,
              text: fp.roleGroup === "button_like" ? (fp.clues.text ?? null) : null,
              region:
                fp.box === null
                  ? null
                  : { x: fp.box.x / view.width, y: fp.box.y / view.height, w: fp.box.width / view.width, h: fp.box.height / view.height },
              path: fp.clues.path,
              field_kind: fp.fieldKind ?? null,
            },
    };
  }
}
