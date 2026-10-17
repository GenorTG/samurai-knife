// Per-account storage maintenance from a terminal (same library as the server, src/lib/storage).
//
//   npm run storage -- seal [--dry-run] [--verbose]   seal every plaintext per-account file in place (one-time upgrade
//                                                     step; run with the server stopped; back up the data dir first)
//   npm run storage -- unseal [--dry-run] [--verbose] open every sealed file in place again (rollback to a build from
//                                                     before sealing; server stopped; the key is left where it is)
//   npm run storage -- rename-account <old> <new>     rename an account and move (re-seal) everything it owns; MCP keys
//                                                     follow, sessions end (server stopped; back up the data dir first)
//
// Reads .env.local like scripts/serve.mjs (KNIFE_DATA_DIR, KNIFE_STORAGE_KEY_FILE).
import { readStore } from "@/lib/accounts/store";
import { renameAccount, sealAccountStorage, unsealAccountStorage } from "@/lib/storage/migrate";
import { storageKeyPath } from "@/lib/storage/sealed";

try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const [command, ...rest] = process.argv.slice(2);
if (command === "rename-account") {
  const [from, to] = process.argv.slice(3);
  if (!from || !to) {
    console.error("usage: npm run storage -- rename-account <old> <new>");
    process.exit(2);
  }
  const report = renameAccount(from, to);
  console.log(`renamed ${from} -> ${to}: ${report.files} file(s) moved, ${report.mcpKeysMoved} MCP key(s) moved, ${report.sessionsRevoked} session(s) ended`);
  process.exit(0);
}
if (command !== "seal" && command !== "unseal") {
  console.error("usage: npm run storage -- seal|unseal [--dry-run] [--verbose]");
  process.exit(2);
}
const dryRun = rest.includes("--dry-run");
const verbose = rest.includes("--verbose");

let total = 0;
for (const account of readStore().accounts) {
  const report = (command === "seal" ? sealAccountStorage : unsealAccountStorage)(account.id, { dryRun });
  total += report.sealed;
  console.log(command === "seal"
    ? `${account.id}: ${report.sealed} ${dryRun ? "to seal" : "sealed"}, ${report.alreadySealed} already sealed`
    : `${account.id}: ${report.sealed} ${dryRun ? "to open" : "opened"}`);
  if (verbose) for (const file of report.files) console.log(`  ${file}`);
}
console.log(`${dryRun ? "would " : ""}${command === "seal" ? (dryRun ? "seal" : "sealed") : (dryRun ? "open" : "opened")} ${total} file(s); storage key: ${storageKeyPath()}`);
