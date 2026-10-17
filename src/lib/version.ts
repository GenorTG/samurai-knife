import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Build version, the Finetune Studio scheme: the repo-root `VERSION` file holds MAJOR.MINOR.PATCH.BUILD; the versioned
 * pre-commit hook (scripts/git-hooks/pre-commit, `npm run hooks` once per clone) adds 1 to BUILD in every commit, so the
 * shell chip and GET /api/system/version pin the exact code that runs. package.json `version` carries MAJOR.MINOR.PATCH.
 * A release is the tag `v<VERSION>` (docs/DEPLOY.md "Releases"). Server-only (reads the file).
 */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;

export function appVersion(): string {
  try {
    const text = readFileSync(join(process.cwd(), "VERSION"), "utf8").trim();
    if (VERSION_PATTERN.test(text)) return text;
  } catch {
    /* no VERSION file (a copy without it): fall back below */
  }
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: string };
    if (pkg.version && /^\d+\.\d+\.\d+$/.test(pkg.version)) return `${pkg.version}.0`;
  } catch {
    /* not run from the checkout */
  }
  return "0.0.0.0";
}
