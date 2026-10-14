// Dumps what the NoSQL lab libraries generate for a spec corpus, for the independent Python oracles in
// tests/nosql_snippets_e2e.py. Usage: node ... tests/nosql_dump.mjs <in.json> <out.json>
//   in.json:  [{store, id, spec?|specText?}]
//   out.json: [{store, id, ok, issues, snippets: {label: code}, compact: {label: code}}]
import { readFileSync, writeFileSync } from "node:fs";
import * as chroma from "../src/lib/nosql/chroma.ts";
import { parseJsonLossless } from "../src/lib/nosql/common.ts";
import * as mongo from "../src/lib/nosql/mongo.ts";
import * as redis from "../src/lib/nosql/redis.ts";

const stores = { mongo, chroma, redis };
const [input, output] = process.argv.slice(2);
const entries = JSON.parse(readFileSync(input, "utf8"));
const byLabel = (result) => Object.fromEntries(result.snippets.map((s) => [s.label, { language: s.language, code: s.code }]));
const out = entries.map((entry) => {
  const lib = stores[entry.store];
  let spec = entry.spec;
  if (entry.specText !== undefined) {
    if (entry.store === "mongo") {
      const parsed = mongo.parseSpecText(entry.specText);
      spec = parsed.spec;
    } else {
      const parsed = parseJsonLossless(entry.specText);
      spec = parsed.ok ? parsed.value : undefined;
    }
  }
  const result = lib.compile(spec);
  const compact = lib.compile(spec, { compact: true });
  return { store: entry.store, id: entry.id, ok: result.ok, issues: result.issues, snippets: byLabel(result), compact: byLabel(compact) };
});
writeFileSync(output, JSON.stringify(out));
