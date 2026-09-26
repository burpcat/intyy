// Import rules for intyy. tests/structure/imports.test.ts runs them.
// Follows build plan section 10 §5.3, the four dependency-cruiser rows.

/** Why: core talks to the world only through ports (section 10 §5.3, row 1). */
const coreToWorld = {
  name: "core-no-world",
  comment: "src/core/ imports no adapter, CLI, Playwright, model SDK, node:fs, or node:child_process.",
  severity: "error",
  from: { path: "^src/core/" },
  to: {
    path: [
      "^src/adapters/",
      "^src/cli/",
      "(^|node_modules/)(playwright|playwright-core|@anthropic-ai/[^/]+)(/|$)",
      "^(node:)?(fs|child_process)(/|$)",
    ],
  },
};

/** Why: only the gate may hold hands (section 10 §5.3, row 2). */
const handsPort = {
  name: "hands-port-only-gate",
  comment: "Only core/safety/gate/, adapters/playwright/, and fakes/ import ports/hands.ts.",
  severity: "error",
  from: { pathNot: "^src/(core/safety/gate|adapters/playwright|fakes)/" },
  to: { path: "^src/ports/hands\\.ts$" },
};

/** Why: certify is the only core user of the harness (section 10 §5.3, row 3). */
const harnessPort = {
  name: "harness-port-only-certify",
  comment: "Only core/certify/, adapters/kvfcu-harness/, and fakes/ import ports/harness.ts.",
  severity: "error",
  from: { pathNot: "^src/(core/certify|adapters/kvfcu-harness|fakes)/" },
  to: { path: "^src/ports/harness\\.ts$" },
};

/** Why: cli/wiring.ts is the only place that picks adapters (section 10 §5.3, row 4). */
const adaptersFromWiring = {
  name: "adapters-only-from-wiring",
  comment: "Only cli/wiring.ts imports adapter modules.",
  severity: "error",
  from: { pathNot: "^src/(cli/wiring\\.ts$|adapters/)" },
  to: { path: "^src/adapters/" },
};

/** Same rule, inside adapters: an adapter may import its own folder, never another adapter. */
const adaptersCrossImport = {
  name: "adapters-only-from-wiring",
  comment: "An adapter imports only files in its own folder.",
  severity: "error",
  from: { path: "^src/adapters/([^/]+)/" },
  to: { path: "^src/adapters/", pathNot: "^src/adapters/$1/" },
};

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [coreToWorld, handsPort, harnessPort, adaptersFromWiring, adaptersCrossImport],
  options: {
    doNotFollow: { path: "node_modules" },
    // Why: `import type` still couples modules, so type-only imports count.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
  },
};
