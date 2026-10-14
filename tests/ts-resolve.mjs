// Lets `node --test` import the app's TypeScript modules:
//  - extensionless relative imports (src/lib/nosql/*.ts import each other as "./common"), which tsc and Next resolve but Node's
//    ESM resolver does not;
//  - the `@/` alias (tsconfig paths: "@/*" -> "src/*"), so server modules such as src/lib/cv/store.ts can be unit-tested.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = new URL("../src/", import.meta.url);
const HAS_EXTENSION = /\.(?:ts|tsx|js|mjs|cjs|json)$/;

function resolveAlias(specifier) {
  const rest = specifier.slice(2);
  const candidates = HAS_EXTENSION.test(rest) ? [rest] : [`${rest}.ts`, `${rest}.tsx`, `${rest}/index.ts`];
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
      if (error?.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && !HAS_EXTENSION.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
