// Durable assistant goals ("Tasks", src/lib/agent-work/goals.ts, knife_goal_* in src/lib/mcp/tools-goals.ts):
// create, steps, checkpoints, pause/resume/complete, delete; sealed at rest, inside the storage quota, removed with the
// account, and strictly per account (another account's goal id is "not found" through the tools).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/agent_goals.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-goals-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_AUTH_MODE = "public";
process.env.KNIFE_EMAIL_DNS = "off";
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../src/lib/accounts/store.ts");
const goals = await import("../src/lib/agent-work/goals.ts");
const { GOAL_KNIFE_TOOLS } = await import("../src/lib/mcp/tools-goals.ts");
const { accountScope } = await import("../src/lib/storage/scope.ts");
const { accountDataPaths, deleteAccountData } = await import("../src/lib/accounts/data.ts");
const { storageUsage } = await import("../src/lib/storage/quota.ts");

store.mutateStore((s) => {
  s.accounts.push(store.newAccountRecord({ id: "alice", displayName: "Alice", role: "user", status: "active" }));
  s.accounts.push(store.newAccountRecord({ id: "bob", displayName: "Bob", role: "user", status: "active", storageQuotaBytes: 4096 }));
});
const tool = (name) => GOAL_KNIFE_TOOLS.find((t) => t.name === name);
const alice = { accountId: "alice", admin: false };
const bob = { accountId: "bob", admin: false };

test("create, steps, checkpoint, pause/resume/complete, history", async () => {
  const goal = await tool("knife_goal_create").execute({ title: "Fix my website SEO", objective: "SEO 100 on the HTML pages", project: "jan.example.test", steps: ["Audit", "Fix titles", "Re-audit"], nextAction: "Run the audit" }, alice);
  assert.equal(goal.status, "active");
  assert.equal(goal.steps.length, 3);
  assert.ok(goal.steps.every((s) => s.status === "pending"));
  const step = goal.steps[0];
  const after = await tool("knife_goal_checkpoint").execute({ id: goal.id, note: "Audit audit_ab12: SEO 92, 3 findings", stepId: step.id, stepStatus: "completed", nextAction: "Fix titles" }, alice);
  assert.equal(after.steps[0].status, "completed");
  assert.equal(after.nextAction, "Fix titles");
  assert.match(after.events.at(-1).text, /audit_ab12/);
  assert.equal((await tool("knife_goal_update").execute({ id: goal.id, status: "paused" }, alice)).status, "paused");
  assert.equal((await tool("knife_goal_update").execute({ id: goal.id, status: "active" }, alice)).status, "active");
  const done = await tool("knife_goal_update").execute({ id: goal.id, status: "completed" }, alice);
  assert.match(done.events.at(-1).text, /active → completed/);
  assert.equal((await tool("knife_goal_list").execute({ includeCompleted: false }, alice)).length, 0);
  assert.equal((await tool("knife_goal_list").execute({}, alice)).length, 1);
  await assert.rejects(tool("knife_goal_checkpoint").execute({ id: goal.id, note: "x", stepId: "nope", stepStatus: "completed" }, alice), /Step not found/);
});

test("per account: another account's goal id is not found, its list is empty", async () => {
  const [goal] = goals.listAgentGoals("alice");
  assert.deepEqual(await tool("knife_goal_list").execute({}, bob), []);
  await assert.rejects(tool("knife_goal_update").execute({ id: goal.id, status: "archived" }, bob), /Goal not found/);
  await assert.rejects(tool("knife_goal_checkpoint").execute({ id: goal.id, note: "bob was here" }, bob), /Goal not found/);
  assert.throws(() => goals.deleteAgentGoal("bob", goal.id), /Goal not found/);
  assert.equal(goals.listAgentGoals("alice")[0].status, "completed", "untouched");
  await assert.rejects(tool("knife_goal_list").execute({}, undefined), /account context/);
});

test("sealed at rest, counted in the storage quota, refused over it", async () => {
  const path = accountScope("alice").goalsFile;
  const raw = readFileSync(path);
  assert.ok(!raw.includes(Buffer.from("Fix my website SEO")), "the goal title is not readable on disk");
  assert.ok(storageUsage("alice").areas.goals > 0);
  await tool("knife_goal_create").execute({ title: "small", objective: "fits" }, bob);
  await assert.rejects(tool("knife_goal_create").execute({ title: "big", objective: "x".repeat(4000), steps: Array.from({ length: 40 }, (_, i) => `step ${i} ${"y".repeat(100)}`) }, bob), /quota|storage|space/i);
});

test("delete one goal; account deletion removes the goals file", async () => {
  const [goal] = goals.listAgentGoals("alice");
  goals.deleteAgentGoal("alice", goal.id);
  assert.equal(goals.listAgentGoals("alice").length, 0);
  assert.ok(accountDataPaths("alice").includes(accountScope("alice").goalsFile));
  await tool("knife_goal_create").execute({ title: "again", objective: "for deletion" }, alice);
  assert.ok(existsSync(accountScope("alice").goalsFile));
  deleteAccountData("alice");
  assert.ok(!existsSync(accountScope("alice").goalsFile));
});
