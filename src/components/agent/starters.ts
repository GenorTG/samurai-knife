/** Starter prompts for the assistant's empty state, tuned to the page; suites with their own workflow override the generic three. */

const SUITE_STARTERS: Readonly<Record<string, readonly string[]>> = {
  "sql-lab": [
    "Here is my schema: CREATE TABLE users(id integer primary key, name text, created_at timestamp); CREATE TABLE orders(id integer primary key, user_id integer, total numeric). Write a PostgreSQL query for the five users with the highest order total, and check it against the schema.",
    "Convert this SQLite upsert to PostgreSQL and MySQL and tell me what changed: INSERT INTO kv(k, v) VALUES ('a', 1) ON CONFLICT(k) DO UPDATE SET v = excluded.v;",
    "I don't know SQL: I have a CSV of orders and want the monthly revenue. Load it in the Run tab and get me the numbers.",
  ],
  "nosql-lab": [
    "Write a MongoDB query for users older than 30 in Warsaw sorted by newest, as mongosh and PyMongo, and explain each part.",
    "Build a Chroma query for the 5 nearest documents to 'refund policy' where metadata category is 'legal' and year is at least 2024.",
    "Which Redis commands do I need for a rate limiter that allows 10 requests a minute per user? Show redis-cli and redis-py.",
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
