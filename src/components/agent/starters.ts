/** Starter prompts for the assistant's empty state, tuned to the page; suites with their own workflow override the generic three. */

const SUITE_STARTERS: Readonly<Record<string, readonly string[]>> = {
  "sql-lab": [
    "Here is my schema: CREATE TABLE users(id integer primary key, name text, created_at timestamp); CREATE TABLE orders(id integer primary key, user_id integer, total numeric). Write a PostgreSQL query for the five users with the highest order total, and check it against the schema.",
    "Convert this SQLite upsert to PostgreSQL and MySQL and tell me what changed: INSERT INTO kv(k, v) VALUES ('a', 1) ON CONFLICT(k) DO UPDATE SET v = excluded.v;",
    "I don't know SQL: I have a CSV of orders and want the monthly revenue. Load it in the Run tab and get me the numbers.",
  ],
};

export function starterPrompts(tool: { slug: string; name: string } | undefined): string[] {
  if (!tool) {
    return [
      "What tools do you have?",
      "I have a scanned PDF — find the best tools to get its text out and shrink it.",
      "Open the QR tool and make a code for https://example.com",
    ];
  }
  const custom = SUITE_STARTERS[tool.slug];
  if (custom) return [...custom];
  return [
    `What can ${tool.name} do? Walk me through it.`,
    `Try ${tool.name} on a realistic sample so I can watch.`,
    `What other tools pair well with ${tool.name}?`,
  ];
}
