// Module resolution for the workflow worker process (src/lib/workflows/worker/main.ts), which runs the app's TypeScript
// with Node's type stripping instead of a bundle: extensionless relative imports and the `@/` alias (tsconfig paths),
// like tests/ts-resolve.mjs. Plain .mjs: loaded with --import before any TypeScript.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = new URL("../../../", import.meta.url);
const HAS_EXTENSION = /\.(?:ts|tsx|js|mjs|cjs|json)$/;

function resolveAlias(specifier) {
  const rest = specifier.slice(2);
  const candidates = HAS_EXTENSION.test(rest) ? [rest] : [`${rest}.ts`, `${rest}/index.ts`];
  for (const candidate of candidates) {
    const path = fileURLToPath(new URL(candidate, SRC));
    if (existsSync(path)) return pathToFileURL(path).href;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = resolveAlias(specifier);
      if (target) return nextResolve(target, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === "ERR_UNSUPPORTED_DIR_IMPORT" && specifier.startsWith(".")) return nextResolve(`${specifier}/index.ts`, context);
      if (error?.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && !HAS_EXTENSION.test(specifier)) {
        try {
          return nextResolve(`${specifier}.ts`, context);
        } catch {
          return nextResolve(`${specifier}/index.ts`, context);
        }
      }
      throw error;
    }
  },
});
