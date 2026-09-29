// Output rules: the answer goes to standard output; progress, warnings, and errors to standard error.
// Follows design section 9 §7.4 and section 4 §9.14 (raw outputs only on a terminal).

/** The streams and environment a command runs with. Tests pass fakes. */
export type Io = {
  stdout: { write(text: string): unknown; isTTY?: boolean };
  stderr: { write(text: string): unknown };
  /**
   * Standard input, for `--note` (piped) and the `review` guided walk (a terminal).
   * Follows docs/decisions.md, M04: input values never go on a flag.
   */
  stdin: {
    isTTY?: boolean;
    /** Reads every byte already waiting, as text. Piped input only: a terminal has no EOF. */
    readAll(): Promise<string>;
    /** Asks one question on a terminal and reads the answered line. */
    question(prompt: string): Promise<string>;
  };
  env: Record<string, string | undefined>;
  cwd: string;
};

/**
 * A command's answer. `raw` is true when raw sensitive outputs may print: on a terminal, or with
 * `--reveal-outputs` where allowed (section 9 §7.4). M01 answers hold no sensitive outputs.
 */
export type Answer = {
  text(raw: boolean): string;
  data(raw: boolean): unknown;
  /** The exit code, when the answer itself reports a problem. Example: a bound secret is missing. */
  code?: number;
};

/** How to print. */
export type PrintOptions = { json: boolean; reveal: boolean };

/** Prints the answer. `--json` prints exactly one JSON document; otherwise human text. */
export function printAnswer(io: Io, answer: Answer, opts: PrintOptions): void {
  const raw = io.stdout.isTTY === true || opts.reveal;
  if (opts.json) io.stdout.write(`${JSON.stringify(answer.data(raw), null, 2)}\n`);
  else io.stdout.write(ensureNewline(answer.text(raw)));
}

/**
 * Prints an error. The human text always goes to standard error. With `--json`, standard output
 * still gets its one document: `{ "error": { "code", "message" } }`.
 */
export function printError(io: Io, code: number, message: string, opts: PrintOptions): void {
  io.stderr.write(ensureNewline(`intyy: ${message}`));
  if (opts.json) io.stdout.write(`${JSON.stringify({ error: { code, message } }, null, 2)}\n`);
}

/** Prints one progress or warning line to standard error. */
export function progress(io: Io, line: string): void {
  io.stderr.write(ensureNewline(line));
}

/** A simple answer: the same data as JSON, and a text form. */
export function answer(data: unknown, text: string, code?: number): Answer {
  return code === undefined
    ? { text: () => text, data: () => data }
    : { text: () => text, data: () => data, code };
}

function ensureNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
