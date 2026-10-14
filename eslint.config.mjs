import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Local scratch (reports, lane harnesses): never part of the app.
    ".tmp/**",
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "public/ocr/**",
    "public/sql/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
