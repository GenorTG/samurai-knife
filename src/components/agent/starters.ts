import { msg } from "@/lib/i18n/msg";

/** Starter prompts for the assistant's empty state, tuned to the page; suites with their own workflow override the generic three. In the interface language (`t`): the model answers in it. */

const SUITE_STARTERS: Readonly<Record<string, readonly string[]>> = {
  "sql-lab": [
    msg("Here is my schema: CREATE TABLE users(id integer primary key, name text, created_at timestamp); CREATE TABLE orders(id integer primary key, user_id integer, total numeric). Write a PostgreSQL query for the five users with the highest order total, and check it against the schema."),
    msg("Convert this SQLite upsert to PostgreSQL and MySQL and tell me what changed: INSERT INTO kv(k, v) VALUES ('a', 1) ON CONFLICT(k) DO UPDATE SET v = excluded.v;"),
    msg("I don't know SQL: I have a CSV of orders and want the monthly revenue. Load it in the Run tab and get me the numbers."),
  ],
};

export function starterPrompts(tool: { slug: string; name: string } | undefined, t: (text: string, vars?: Record<string, string>) => string = (x) => x): string[] {
  if (!tool) {
    return [
      t("What tools do you have?"),
      t("I have a scanned PDF — find the best tools to get its text out and shrink it."),
      t("Open the QR tool and make a code for https://example.com"),
    ];
  }
  const custom = SUITE_STARTERS[tool.slug];
  if (custom) return custom.map((text) => t(text));
  return [
    t("What can {name} do? Walk me through it.", { name: t(tool.name) }),
    t("Try {name} on a realistic sample so I can watch.", { name: t(tool.name) }),
    t("What other tools pair well with {name}?", { name: t(tool.name) }),
  ];
}
