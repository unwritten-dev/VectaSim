// ESLint 9 flat config. Deliberately moderate: tsc (strict, noUnused*) already checks types
// and unused code, so this adds what tsc cannot see – the React hooks rules (effect
// dependencies above all) and typescript-eslint's recommended syntax rules (no type
// information needed, so linting stays fast). Stale `eslint-disable` comments are errors.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist/", "src-tauri/", "node_modules/"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // the two classic hooks rules; the React-Compiler rules of plugin v6+ are not enabled
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      // tsc reports unused locals/parameters already
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // tests and the Vite config run in Node
    files: ["**/*.test.{ts,tsx}", "vite.config.ts", "eslint.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },
);
