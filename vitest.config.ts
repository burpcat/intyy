// Vitest projects for intyy: unit, types, and live.
// Follows build plan section 10 §5.4, "Where tests live".
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/{unit,contract,golden,structure}/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "types",
          include: [],
          typecheck: {
            enabled: true,
            only: true,
            include: ["tests/types/**/*.test-d.ts"],
            tsconfig: "tsconfig.json",
          },
        },
      },
      {
        test: {
          name: "live",
          include: ["tests/live/**/*.test.ts"],
          // Why: CONTRACT §2, one run at a time against the bank app.
          fileParallelism: false,
          // Why: CONTRACT §6, a bank request may take 8 s, and one step can make several.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
