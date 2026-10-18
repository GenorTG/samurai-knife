// Email address policy lists from a terminal (same library as the server, src/lib/accounts/email-policy.ts).
//
//   npm run email-lists -- update [--ref <git ref>] [--sha256 <hex>] [--force] [--dry-run]
//        download + validate the CC0 disposable-domain list into $KNIFE_DATA_DIR/email-policy/disposable.txt (weekly
//        timer; the server picks it up by itself). --ref/--sha256 pin a reviewed commit and its hash; --force accepts a
//        list much smaller than the current one. Exit 1 (and the old list stays) when the download does not validate.
//   npm run email-lists -- status          which lists are in force and how big they are
//   npm run email-lists -- check <address> the policy verdict for one address (static rules, lists, DNS)
//
// Reads .env.local like scripts/serve.mjs (KNIFE_DATA_DIR, KNIFE_AUTH_MODE, KNIFE_EMAIL_POLICY). Owner lists:
// allow.txt / deny.txt in the same directory, edited by hand (one domain, or in deny.txt also a full address, per line).
import { checkEmailPolicy, emailPolicyDir, emailPolicyStats } from "@/lib/accounts/email-policy";
import { updateDisposableList } from "@/lib/accounts/email-lists/update";

try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const [command, ...rest] = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
};

if (command === "update") {
  const result = await updateDisposableList({ ref: option("--ref"), sha256: option("--sha256"), force: rest.includes("--force"), dryRun: rest.includes("--dry-run") });
  if (!result.ok) {
    console.error(`email-lists: ${result.error} (the current list stays in force)`);
    process.exit(1);
  }
  console.log(`${result.written ? "updated" : "validated (dry run)"}: ${result.domains} domains (was ${result.previous}), sha256 ${result.sha256}, from ${result.url} -> ${emailPolicyDir()}`);
  process.exit(0);
}
if (command === "status") {
  console.log(JSON.stringify({ dir: emailPolicyDir(), ...emailPolicyStats() }, null, 2));
  process.exit(0);
}
if (command === "check" && rest[0]) {
  console.log(JSON.stringify(await checkEmailPolicy(rest[0], { ...process.env, KNIFE_EMAIL_POLICY: "enforce" }), null, 2));
  process.exit(0);
}
console.error("usage: npm run email-lists -- update [--ref <ref>] [--sha256 <hex>] [--force] [--dry-run] | status | check <address>");
process.exit(2);
