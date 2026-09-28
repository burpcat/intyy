// Test helpers for opening a surface behind the gate: a merged test policy, gate deps, a lease.
// The global layer is the approved library file; the app layer is a tiny test policy.
// Design section 4 §3.3 and §4.1; M02 task 7.
import { readFileSync } from "node:fs";
import { GlobalPolicy, AppPolicy } from "../../../src/core/model/policy.js";
import { buildAllowlist } from "../../../src/core/safety/policy/allowlist.js";
import { mergePolicy, type EffectivePolicy } from "../../../src/core/safety/policy/merge.js";
import { Redactor, redactionRules } from "../../../src/core/safety/redaction/redactor.js";
import {
  openGate,
  type Gate,
  type GateDeps,
  type GateLine,
  type GateRun,
} from "../../../src/core/safety/gate/gate.js";
import type {
  Eyes,
  LeaseToken,
  SessionConfig,
  SurfaceFactory,
} from "../../../src/ports/surface.js";

/** The one lease every test holds. M07 builds real leases. */
export const LEASE = "lease-test" as unknown as LeaseToken;

/** The approved global policy from the library. */
const globalLayer = GlobalPolicy.parse(
  JSON.parse(
    readFileSync(new URL("../../../library/policy/global/1.json", import.meta.url), "utf8"),
  ),
);

/** Merges the global layer with a test app layer that allows `paths`. */
export function testPolicy(paths: {
  allow: string[];
  deny: string[];
  irreversible: string[];
}): EffectivePolicy {
  const app = AppPolicy.parse({
    schema: "intyy.policy/1.0",
    scope: { level: "app", app: "testapp" },
    revision: 1,
    reason: "Test policy.",
    paths: { ...paths, case_sensitive: true },
    risk: { key_labels: { F2: "search" } },
  });
  const merged = mergePolicy({ global: globalLayer, app });
  if (!merged.ok) throw new Error(`test policy does not merge: ${merged.detail ?? ""}`);
  return merged.value.effective;
}

/** A discovery run with no artifact. */
export const DISCOVERY: GateRun = {
  kind: "discovery",
  readOnly: false,
  forceHuman: false,
  authorizationValid: () => false,
  declaredPaths: null,
};

/** A session config for `origin` under `policy`. `extra` lists extra allowed origins. */
export function gateConfig(
  origin: string,
  policy: EffectivePolicy,
  extra: string[] = [],
  visible = false,
): SessionConfig {
  return {
    origin,
    allowlist: buildAllowlist({
      origin,
      extraOrigins: extra,
      paths: policy.paths,
      browser: policy.browser,
    }),
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timeZone: "America/New_York",
    visible,
  };
}

/** An open gate, its eyes, and every gate line it wrote. */
export type Opened = { eyes: Eyes; gate: Gate; lines: GateLine[] };

/** Gate deps for a test. Every gate line lands in `lines`. */
export function testDeps(policy: EffectivePolicy, run: GateRun, lines: GateLine[]): GateDeps {
  return {
    policy,
    redactor: new Redactor(redactionRules(policy)),
    run,
    lease: () => LEASE,
    log: (l) => lines.push(l),
  };
}

/** Opens `factory` behind the gate, or fails the test. */
export async function openTestGate(
  factory: SurfaceFactory,
  cfg: SessionConfig,
  policy: EffectivePolicy,
  run: GateRun = DISCOVERY,
): Promise<Opened> {
  const lines: GateLine[] = [];
  const opened = await openGate(factory, cfg, testDeps(policy, run, lines));
  if (!opened.ok) throw new Error(`open failed: ${opened.failure}`);
  return { ...opened.value, lines };
}
