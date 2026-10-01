// The operator port: carries intervention requests to humans, and their answers back.
// Follows design section 9 §5.4.
import type { Masked } from "./masked.js";
import type { Opaque } from "./opaque.js";
import type { Outcome } from "./outcome.js";

/**
 * One intervention request (section 7 §13.1). The core builds it and checks it against
 * `intyy.intervention/1.0`; the adapter only stores it.
 */
export type Intervention = { schema: "intyy.intervention/1.0"; kind: string } & Record<
  string,
  unknown
>;

/** A handle to one open intervention. */
export type Handle = Opaque<"OperatorHandle">;

/** What a human did: claim, release, decide, or answer a dialog (section 9 §5.4). */
export type OperatorEvent =
  | { kind: "claimed"; staff: string; implicit: boolean }
  | { kind: "released"; staff: string; note?: string }
  | { kind: "decided"; staff: string; decision: string; outcome?: string; note?: string }
  | { kind: "dialog"; staff: string; answer: "accept" | "dismiss" };

/** The operator port. Deadlines use the clock port in the core; adapters never time out a human. */
export interface OperatorPort {
  /** Opens a request. */
  open(req: Masked<Intervention>, signal?: AbortSignal): Promise<Outcome<Handle, "write_failed">>;
  /** The next claim, release, decision, or dialog answer. The core owns the deadline. */
  next(h: Handle, signal?: AbortSignal): Promise<Outcome<OperatorEvent, "closed">>;
  /** Closes a request. */
  close(h: Handle, how: "resolved" | "timed_out" | "run_ended"): Promise<void>;
}

/** The open request of one run, as the operator CLI sees it. `request` is the raw file. */
export type OpenRequest = {
  /** The request's folder name, like `01_approval`. */
  folder: string;
  request: unknown;
  /** True once `decision.json` exists. */
  decided: boolean;
  /** The raw `claim.json`, or null while nobody has claimed (section 9 §10.5). */
  claim: unknown;
  /** True once `release.json` exists. */
  released: boolean;
  /** The run folder on disk, so the CLI can print a full screenshot path. */
  runDir: string;
};

/** The operator CLI's side of the mailbox: read the open request, write one decision. */
export interface InterventionDesk {
  /** The newest request of a run with no `closed.json`, or null when none is open. */
  openRequest(
    tenant: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<Outcome<OpenRequest | null, "not_found">>;
  /** Writes `decision.json` with exclusive create, so a second answer fails (section 9 §10.5). */
  decide(
    tenant: string,
    runId: string,
    folder: string,
    decision: Masked<unknown>,
    signal?: AbortSignal,
  ): Promise<Outcome<void, "already_decided" | "write_failed">>;
  /** Writes `claim.json` with exclusive create, so a second claimer fails (section 9 §10.5). */
  claim(
    tenant: string,
    runId: string,
    folder: string,
    claim: Masked<unknown>,
    signal?: AbortSignal,
  ): Promise<Outcome<void, "already_claimed" | "write_failed">>;
  /** Writes `release.json` with exclusive create: the handback happens once. */
  release(
    tenant: string,
    runId: string,
    folder: string,
    release: Masked<unknown>,
    signal?: AbortSignal,
  ): Promise<Outcome<void, "already_released" | "write_failed">>;
  /** Adds one line to `dialogs.jsonl`, written atomically (section 9 §10.5). */
  dialog(
    tenant: string,
    runId: string,
    folder: string,
    line: Masked<unknown>,
    signal?: AbortSignal,
  ): Promise<Outcome<void, "write_failed">>;
}
