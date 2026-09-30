// Small shared schemas: IDs, names, words, patterns, and origins.
// Follows design section 9 §6.1, §7.7, section 4 §4.8 (loader checks), and §5.4.
import { z } from "zod";
import { parsePattern } from "../safety/policy/paths.js";

/** A tenant ID. Example: `keystone`. */
export const TenantId = z.string().regex(/^[a-z][a-z0-9_-]*$/, "a tenant ID is lower case");

/** An app ID. Example: `kvfcu`. */
export const AppId = z.string().regex(/^[a-z][a-z0-9_-]*$/, "an app ID is lower case");

/** A staff ID. Example: `op_017`. */
export const StaffId = z.string().regex(/^[a-z][a-z0-9_]*$/, "a staff ID is lower case");

/** `app/capability`, no version. Used where a version is resolved elsewhere: `run.json`'s
 * `capability` field and a result's `capability.name` (section 3 §7.3, §5.1). */
export const AppCapabilityName = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_]*$/, "app/capability");

/**
 * One input or output value on the wire (section 3 §5.3): `money`, `decimal`, and `date` are
 * strings; `integer` is a number; `boolean` is a boolean. Shared by a request's `inputs` and a
 * result's `outputs`.
 */
export const ContractValue = z.union([z.string(), z.number(), z.boolean()]);

/** One input or output value. */
export type ContractValue = z.infer<typeof ContractValue>;

/** An environment variable name. Example: `ANTHROPIC_API_KEY`. */
export const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "an environment variable name");

/** A secret name. Example: `operator_password`. */
export const SecretName = z.string().regex(/^[a-z][a-z0-9_]*$/, "a secret name is lower case");

/** One word part: letters or digits, joined by `'`, `/`, or `-`. Examples: `mother's`, `a/c`, `e-mail`. */
const WORD_PART = "[a-z0-9]+(?:['/-][a-z0-9]+)*";

/** A risk or label word: lower case, one to three words (section 4 §4.8). Example: `close account`. */
export const Word = z
  .string()
  .regex(new RegExp(`^${WORD_PART}(?: ${WORD_PART}){0,2}$`), "lower case, one to three words");

/**
 * A path pattern (section 4 §4.8, §6.3). Example: `/members/*`. The regex is the part JSON Schema
 * can show. The path matcher's parse adds the rest.
 */
export const PathPattern = z
  .string()
  .regex(/^\/\S*$/, "a path pattern starts with /")
  .superRefine((value, ctx) => {
    const p = parsePattern(value);
    if (!p.ok) ctx.addIssue({ code: "custom", message: p.detail ?? "not a path pattern" });
  });

/** A capability pattern (section 4 §4.6). Examples: `kvfcu/*@1`, `kvfcu/close_account@*`, `*`. */
export const CapabilityPattern = z
  .string()
  .regex(/^(\*|[a-z0-9_*]+\/[a-z0-9_*]+@(\*|\d+))$/, "a capability pattern like kvfcu/*@1");

/** A key name. Examples: `Enter`, `ArrowUp`, `F2`. */
export const KeyName = z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "a key name like Enter or F2");

/** Hosts that may use `http` (section 4 §5.4): the local bank app. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True when a URL host name is an IP address. The URL parser writes IPv6 in brackets. */
function isIpAddress(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith("[");
}

/** True when `origin`'s host is loopback. */
export function isLoopback(origin: string): boolean {
  return URL.canParse(origin) && LOOPBACK.has(new URL(origin).hostname);
}

/**
 * An origin: scheme, host, and port, with no path, user name, or password (section 4 §5.4).
 * `https` only, except a loopback host may use `http`. An IP address only for loopback (§6.2).
 * Example: `http://127.0.0.1:8080`.
 */
export const Origin = z.string().superRefine((value, ctx) => {
  if (!URL.canParse(value)) {
    ctx.addIssue({ code: "custom", message: "origin is not a URL" });
    return;
  }
  const url = new URL(value);
  if (url.username !== "" || url.password !== "") {
    ctx.addIssue({ code: "custom", message: "origin holds no user name or password" });
  }
  if (url.origin !== value) {
    ctx.addIssue({ code: "custom", message: `origin holds no path; write ${url.origin}` });
  }
  if (isIpAddress(url.hostname) && !LOOPBACK.has(url.hostname)) {
    ctx.addIssue({ code: "custom", message: "an IP address is allowed only for loopback" });
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    ctx.addIssue({
      code: "custom",
      message: "origin uses https; only a loopback host may use http",
    });
  }
});
