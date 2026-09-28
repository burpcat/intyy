// Proves a Secret never prints its value. Design section 9 §5.1; M01 test gate.
import { Console } from "node:console";
import { Writable } from "node:stream";
import { format, inspect } from "node:util";
import { describe, expect, test } from "vitest";
import { Secret } from "../../../src/ports/secret.js";

const RAW = "hunter2-raw-value";

/** Runs `fn` with a console that writes into a string, and returns the text. */
function captureConsole(fn: (c: Console) => void): string {
  let text = "";
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      text += chunk.toString();
      done();
    },
  });
  fn(new Console({ stdout: sink, stderr: sink }));
  return text;
}

describe("Secret", () => {
  const secret = new Secret(RAW);

  test("prints as [secret] in strings and templates", () => {
    expect(String(secret)).toBe("[secret]");
    expect(`value: ${String(secret)}`).toBe("value: [secret]");
  });

  test("prints as [secret] in JSON", () => {
    expect(JSON.stringify(secret)).toBe('"[secret]"');
    expect(JSON.stringify({ password: secret })).toBe('{"password":"[secret]"}');
  });

  test("never appears in console.log or util.inspect", () => {
    const text = captureConsole((c) => {
      c.log(secret);
      c.log({ nested: { secret } });
      c.error("%s %o %O %j", secret, secret, secret, secret);
    });
    expect(text).toContain("[secret]");
    expect(text).not.toContain(RAW);
    expect(inspect({ secret }, { showHidden: true, depth: 10 })).not.toContain(RAW);
    expect(format("%s", secret)).toBe("[secret]");
  });

  test("never appears in error text", () => {
    const err = new Error(`login failed with ${String(secret)}`, { cause: secret });
    expect(err.message).not.toContain(RAW);
    expect(inspect(err)).not.toContain(RAW);
  });

  test("hides the value from keys and copies", () => {
    expect(Object.keys(secret)).toEqual([]);
    expect(JSON.stringify(Object.assign({}, secret))).toBe("{}");
  });

  test("opens only through Secret.open", () => {
    expect(Secret.open(secret)).toBe(RAW);
  });
});
