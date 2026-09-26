// ESLint rules for intyy: typescript-eslint plus two restricted-syntax rules.
// Follows build plan section 10 §5.3. dependency-cruiser holds the import rules.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

/** Clock and randomness reads that core must get from the clock and ID ports. */
export const noClockSelectors = [
  {
    selector: "MemberExpression[object.name='Date'][property.name='now']",
    message: "No Date.now() in src/core/. Use the clock port.",
  },
  {
    selector: "NewExpression[callee.name='Date']",
    message: "No new Date() in src/core/. Use the clock port.",
  },
  {
    selector: "CallExpression[callee.name='Date']",
    message: "No Date() in src/core/. Use the clock port.",
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message: "No Math.random() in src/core/. Use the ID port.",
  },
  {
    selector: "Identifier[name='setTimeout']",
    message: "No setTimeout in src/core/. Use the clock port.",
  },
];

/** Casts that make a Masked value. Only core/safety/redaction/ may write them. */
export const noMaskedCastSelectors = [
  {
    selector: "TSAsExpression[typeAnnotation.typeName.name='Masked']",
    message: "Only src/core/safety/redaction/ may cast to Masked.",
  },
  {
    selector: "TSTypeAssertion[typeAnnotation.typeName.name='Masked']",
    message: "Only src/core/safety/redaction/ may cast to Masked.",
  },
];

export default defineConfig(
  { ignores: ["dist/", "state/", "docs/", "library/", "evidence/", ".claude/"] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ["**/*.js", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { module: "writable", require: "readonly" } },
  },
  // Why: in flat config the last matching block wins, so each block lists every selector it needs.
  {
    files: ["src/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...noMaskedCastSelectors] },
  },
  {
    files: ["src/core/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...noMaskedCastSelectors, ...noClockSelectors] },
  },
  {
    files: ["src/core/safety/redaction/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...noClockSelectors] },
  },
);
