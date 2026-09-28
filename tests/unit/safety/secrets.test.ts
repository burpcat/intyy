// Proves secret injection: the start check, and the rules the gate enforces at act time.
// Joined secrets, wrong page, and wrong field kind are all blocked. Values are fetched per action.
// Design section 4 §8.4 to §8.7; section 4 §14, "Secret rules"; M02 task 8.
import { describe, expect, test } from "vitest";
import type { GateRun, TypeValue } from "../../../src/core/safety/gate/gate.js";
import { secretInText, startCheck } from "../../../src/core/safety/secrets/injector.js";
import { MapSecrets } from "../../../src/fakes/secrets.js";
import { SnapshotSurface, type FakeSite } from "../../../src/fakes/snapshot-surface/index.js";
import { toFactory, type SurfaceSession } from "../../../src/ports/hands.js";
import { Secret } from "../../../src/ports/secret.js";
import type { SecretBinding, Secrets } from "../../../src/ports/secrets.js";
import type { Eyes, SurfaceFactory } from "../../../src/ports/surface.js";
import {
  DISCOVERY,
  LEASE,
  TEST_PASSWORD,
  gateConfig,
  openTestGate,
  testPolicy,
  testSecrets,
  type Opened,
} from "../../contract/surface/gate-kit.js";

const ORIGIN = "http://127.0.0.1:9182";

const policy = testPolicy(
  { allow: ["/", "/login"], deny: [], irreversible: [] },
  {
    operator_username: { kind: "username", paths: ["/login"] },
    operator_password: { kind: "password", paths: ["/login"] },
  },
);

const box = (id: string, label: string, kind: "text" | "password") => ({
  id,
  role: "textbox",
  roleGroup: "text_entry" as const,
  label,
  field: { kind, value: "" },
});

const site: FakeSite = {
  origin: ORIGIN,
  screens: {
    "/": { elements: [box("note", "Note", "text"), box("pin", "PIN", "password")] },
    "/login": {
      elements: [
        box("user", "Username", "text"),
        box("pass", "Password", "password"),
        { id: "go", role: "button", roleGroup: "button_like" as const, name: "Sign in" },
      ],
    },
  },
};

const REPLAY: GateRun = { ...DISCOVERY, kind: "replay", declaredPaths: ["/", "/login"] };

/** A secret port that counts how often each value is fetched. */
class CountingSecrets implements Secrets {
  calls = 0;
  readonly #inner = testSecrets(policy).port;
  resolve(b: SecretBinding) {
    this.calls += 1;
    return this.#inner.resolve(b);
  }
}

/** Opens a gate on `factory`, then goes to `/login` when asked. */
async function open(
  opts: { at?: string; run?: GateRun; port?: Secrets; factory?: SurfaceFactory } = {},
): Promise<Opened> {
  const secrets = {
    ...testSecrets(policy),
    ...(opts.port === undefined ? {} : { port: opts.port }),
  };
  const factory = opts.factory ?? toFactory(new SnapshotSurface(site));
  const g = await openTestGate(
    factory,
    gateConfig(ORIGIN, policy),
    policy,
    opts.run ?? DISCOVERY,
    secrets,
  );
  if (opts.at !== undefined) {
    // Why: replay never lets the LLM act, so a replay run navigates as an engine step.
    const replay = (opts.run ?? DISCOVERY).kind === "replay";
    const r = await g.gate.act({
      actor: replay ? "engine" : "llm",
      lease: LEASE,
      action: { type: "navigate", to: opts.at },
      step: null,
      ...(replay ? { confirmed: { risk: "idempotent" as const, words: [] } } : {}),
    });
    if (!r.ok || r.value.decision !== "allowed") throw new Error(`could not go to ${opts.at}`);
  }
  return g;
}

/** The ref of the field with this label. */
async function field(eyes: Eyes, label: string) {
  const o = await eyes.observe();
  const el = o.ok ? o.value.elements.find((e) => e.clues.label === label) : undefined;
  if (el === undefined) throw new Error(`no field ${label}`);
  return el.ref;
}

/** Types `value` into the field as `actor`, and returns "decision rule" or the failure. */
async function typeInto(
  g: Opened,
  label: string,
  value: TypeValue,
  actor: "llm" | "engine" | "handler" | "reviewer" = "llm",
) {
  const flag =
    actor === "engine" || actor === "handler"
      ? { confirmed: { risk: "idempotent" as const, words: [] } }
      : {};
  const r = await g.gate.act({
    actor,
    lease: LEASE,
    action: { type: "type", target: await field(g.eyes, label), value },
    step: "type_password",
    ...flag,
  });
  return r.ok ? `${r.value.decision} ${r.value.rule}` : `${r.failure}: ${r.detail ?? ""}`;
}

const secret = (name: string): TypeValue => ({ kind: "secret", name });
const text = (t: string): TypeValue => ({ kind: "text", text: t });

describe("the start check (section 4 §8.4)", () => {
  test("passes when every required secret has a binding and a value", async () => {
    expect(
      await startCheck(["operator_password", "operator_username"], testSecrets(policy)),
    ).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("names every gap, never a value", async () => {
    const s = {
      ...testSecrets(policy),
      port: new MapSecrets({ INTYY_TEST_OPERATOR_USERNAME: "teller-test" }),
    };
    const r = await startCheck(["operator_password", "operator_username", "supervisor_code"], s);
    expect(r).toEqual({
      ok: false,
      failure: "secret_unavailable",
      detail:
        "operator_password: INTYY_TEST_OPERATOR_PASSWORD has no value; supervisor_code: no binding in settings",
    });
  });
});

describe("secret references in text (rule secret.whole_value)", () => {
  test("a whole reference names the secret; a joined one is joined", () => {
    expect(secretInText("{secret.operator_password}")).toEqual({ name: "operator_password" });
    expect(secretInText("pw={secret.operator_password}")).toBe("joined");
    expect(secretInText("{secret.a}{secret.b}")).toBe("joined");
    expect(secretInText("plain")).toBeNull();
  });
});

describe("injection rules at act time (section 4 §8.5)", () => {
  test("a password secret fills a password box on its page", async () => {
    const g = await open({ at: "/login" });
    expect(await typeInto(g, "Password", secret("operator_password"))).toBe("allowed risk.allowed");
    expect(await typeInto(g, "Username", secret("operator_username"))).toBe("allowed risk.allowed");
  });

  test("the text form {secret.x} is the same secret", async () => {
    const g = await open({ at: "/login" });
    expect(await typeInto(g, "Password", text("{secret.operator_password}"))).toBe(
      "allowed risk.allowed",
    );
  });

  test("a joined secret is blocked", async () => {
    const g = await open({ at: "/login" });
    expect(await typeInto(g, "Password", text("x{secret.operator_password}"))).toBe(
      "blocked secret.whole_value",
    );
  });

  test("the wrong page is blocked", async () => {
    const g = await open();
    expect(await typeInto(g, "PIN", secret("operator_password"))).toBe("blocked secret.path");
  });

  test("an undeclared secret has no page, so it is blocked", async () => {
    const g = await open({ at: "/login" });
    expect(await typeInto(g, "Password", secret("supervisor_code"))).toBe("blocked secret.path");
  });

  test("the wrong field kind is blocked, both ways", async () => {
    const g = await open({ at: "/login" });
    expect(await typeInto(g, "Username", secret("operator_password"))).toBe(
      "blocked secret.field_kind",
    );
    expect(await typeInto(g, "Password", secret("operator_username"))).toBe(
      "blocked secret.field_kind",
    );
    expect(await typeInto(g, "Password", text("hunter2"))).toBe("blocked secret.field_kind");
    const input = {
      kind: "input" as const,
      ref: "input.member_id",
      text: "100107",
      label: "pii" as const,
    };
    expect(await typeInto(g, "Password", input)).toBe("blocked secret.field_kind");
  });

  test("the reviewer never types a secret; a handler may", async () => {
    const g = await open({ at: "/login", run: REPLAY });
    expect(await typeInto(g, "Password", secret("operator_password"), "reviewer")).toBe(
      "blocked allowlist.action",
    );
    expect(await typeInto(g, "Password", secret("operator_password"), "handler")).toBe(
      "allowed risk.allowed",
    );
  });

  test("the value is fetched per action, never at open, and never read back", async () => {
    const port = new CountingSecrets();
    const g = await open({ at: "/login", port });
    expect(port.calls).toBe(0);
    await typeInto(g, "Password", secret("operator_password"));
    await typeInto(g, "Password", secret("operator_password"));
    expect(port.calls).toBe(2);
    const o = await g.eyes.observe();
    const pass = o.ok ? o.value.elements.find((e) => e.clues.label === "Password") : undefined;
    expect(pass?.field).toEqual({ kind: "password", filled: true });
    expect(JSON.stringify([o, g.lines])).not.toContain(TEST_PASSWORD);
  });

  test("a value gone after the start check is an expected failure", async () => {
    const g = await open({ at: "/login", port: new MapSecrets({}) });
    expect(await typeInto(g, "Password", secret("operator_password"))).toBe(
      "secret_unavailable: operator_password: INTYY_TEST_OPERATOR_PASSWORD has no value",
    );
  });
});

describe("errors never echo a secret (section 4 §8.7)", () => {
  /** A surface whose hands throw an error that holds the typed value. */
  function leakySurface(): SurfaceFactory {
    const inner = new SnapshotSurface(site);
    const session: SurfaceSession = {
      async open(cfg) {
        const opened = await inner.open(cfg);
        if (!opened.ok) return opened;
        const { eyes, hands } = opened.value;
        return {
          ok: true,
          value: {
            eyes,
            hands: {
              act(a, lease) {
                if (a.type === "type" && a.text instanceof Secret) {
                  throw new Error(`fill failed for ${Secret.open(a.text)}`);
                }
                return hands.act(a, lease);
              },
            },
          },
        };
      },
      close: () => inner.close(),
    };
    return toFactory(session);
  }

  test("a thrown error carries only the fixed text", async () => {
    const g = await open({ at: "/login", factory: leakySurface() });
    const err = await typeInto(g, "Password", secret("operator_password")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      "Typing {secret.operator_password} into type_password failed.",
    );
    expect((err as Error).message).not.toContain(TEST_PASSWORD);
  });
});
