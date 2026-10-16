// Per-account storage maintenance from a terminal (same library as the server, src/lib/storage).
//
//   npm run storage -- seal [--dry-run] [--verbose]   seal every plaintext per-account file in place (one-time upgrade
//                                                     step; run with the server stopped; back up the data dir first)
//
// Reads .env.local like scripts/serve.mjs (KNIFE_DATA_DIR, KNIFE_STORAGE_KEY_FILE).
import { readStore } from "@/lib/accounts/store";
import { sealAccountStorage } from "@/lib/storage/migrate";
import { storageKeyPath } from "@/lib/storage/sealed";

try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const [command, ...rest] = process.argv.slice(2);
if (command !== "seal") {
  console.error("usage: npm run storage -- seal [--dry-run] [--verbose]");
  process.exit(2);
}
const dryRun = rest.includes("--dry-run");
const verbose = rest.includes("--verbose");

let total = 0;
for (const account of readStore().accounts) {
  const report = sealAccountStorage(account.id, { dryRun });
  total += report.sealed;
  console.log(`${account.id}: ${report.sealed} ${dryRun ? "to seal" : "sealed"}, ${report.alreadySealed} already sealed`);
  if (verbose) for (const file of report.files) console.log(`  ${file}`);
}
console.log(`${dryRun ? "would seal" : "sealed"} ${total} file(s); storage key: ${storageKeyPath()}`);
