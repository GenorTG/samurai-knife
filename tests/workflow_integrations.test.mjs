// Real provider-shaped fixtures through the entire workflow engine, never a direct spec-to-request mapping test.
import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../src/lib/workflows/engine/run.ts";
import { nodeMeta, NODE_CATALOG } from "../src/lib/workflows/catalog/index.ts";
import { nodeImpl, NODE_IMPLS } from "../src/lib/workflows/nodes/index.ts";
import { INTEGRATIONS } from "../src/lib/workflows/integrations/index.ts";

const NOW = Date.UTC(2026, 9, 26, 12);
const bearer = { id: "connection", name: "Test connection", type: "httpBearerAuth", data: { token: "test-token" } };
const header = (name, value) => ({ ...bearer, type: "httpHeaderAuth", data: { name, value } });
const reply = (url, body, status = 200, headers = {}) => ({ url, status, headers: { "content-type": "application/json", ...headers }, body: Buffer.from(body === undefined ? "" : JSON.stringify(body)) });
async function run(type, parameters, http, options = {}) {
  const workflow = {
    id: "wfapps1234", name: "Service fixtures", description: "", version: 1, active: false,
    createdAt: "", updatedAt: "", tags: [], hookToken: "x".repeat(24),
    settings: { timezone: null, errorWorkflow: null, timeoutSeconds: null, saveSuccessfulRuns: true, saveManualRuns: true, callableBy: "any" },
    nodes: [
      { id: "start", name: "Start", type: "core.manual-trigger", typeVersion: 1, position: [0, 0], parameters: {} },
      { id: "app", name: "App", type: `core.${type}`, typeVersion: 1, position: [200, 0], parameters, credentials: { auth: "connection" }, ...options.node },
    ],
    connections: [{ from: { node: "Start", output: 0 }, to: { node: "App", input: 0 } }],
  };
  return runWorkflow({ workflow, mode: "manual", executionId: "integration-test", meta: nodeMeta, impl: nodeImpl,
    triggerItems: options.items ?? [{ json: {} }], signal: options.signal, limits: options.limits,
    services: { now: () => NOW, http, credential: async () => options.credential === undefined ? structuredClone(bearer) : options.credential,
      updateCredential: options.updateCredential, blobs: { put() { throw new Error("no files expected"); }, get() { throw new Error("no files expected"); } } },
  });
}
const output = (result) => result.runData.App?.at(-1).outputs[0];
const jsonOutput = (result) => output(result)?.map((item) => item.json);

const issue = { id: 1001, number: 7, title: "Printer is on fire", state: "open", user: { login: "octocat" }, body: "Help", labels: [{ name: "bug" }] };
const gitlabIssue = { id: 31, iid: 4, project_id: 9, title: "Ship release", state: "opened", web_url: "https://gitlab.com/acme/app/-/issues/4" };
const slackMessage = { type: "message", user: "U123", text: "Build ready", ts: "1720000000.000100" };
const discordMessage = { id: "125000000000000002", channel_id: "125000000000000001", content: "Build ready", author: { id: "123", bot: true } };
const notionPage = { object: "page", id: "f03f3550-2783-4c6b-a6ec-215d7f4196d6", properties: { title: { type: "title", title: [{ plain_text: "Roadmap" }] } }, in_trash: false };
const notionBlock = { object: "block", id: "b03f3550-2783-4c6b-a6ec-215d7f4196d6", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "Hello" } }] } };
const record = { id: "recAbc123", createdTime: "2026-10-26T12:00:00.000Z", fields: { Name: "Ada", Done: false } };
const file = { id: "drive123", name: "Receipts", mimeType: "application/vnd.google-apps.folder", parents: ["root"] };
const event = { kind: "calendar#event", id: "event123", summary: "Standup", start: { dateTime: "2026-10-27T09:00:00+01:00" }, end: { dateTime: "2026-10-27T09:30:00+01:00" }, status: "confirmed" };
const mail = { id: "AAMk-123", subject: "Invoice", from: { emailAddress: { name: "Ada", address: "ada@example.com" } }, bodyPreview: "Attached" };
const teamsMessage = { id: "1720000000000", messageType: "message", body: { contentType: "text", content: "Build ready" } };
const contact = { id: "33451", properties: { email: "ada@example.com", firstname: "Ada" }, createdAt: "2026-10-26T12:00:00Z", updatedAt: "2026-10-26T12:00:00Z", archived: false };

// Each case pins method, API host/version/path, query, auth, JSON body and output against a hand-authored fixture.
const cases = [
  { type: "github", op: "listIssues", p: { owner: "octocat", repository: "hello-world" }, path: "/repos/octocat/hello-world/issues", query: { state: "open", per_page: "50", page: "1" }, fixture: [issue], expected: [issue] },
  { type: "github", op: "getIssue", p: { owner: "octocat", repository: "hello-world", issueNumber: 7 }, path: "/repos/octocat/hello-world/issues/7", fixture: issue, expected: [issue] },
  { type: "github", op: "createIssue", method: "POST", p: { owner: "octocat", repository: "hello-world", title: "Printer is on fire", body: "Help" }, path: "/repos/octocat/hello-world/issues", body: { title: "Printer is on fire", body: "Help" }, fixture: issue, status: 201, expected: [issue] },
  { type: "gitlab", op: "listIssues", p: { project: "acme/app" }, path: "/api/v4/projects/acme%2Fapp/issues", query: { state: "opened", per_page: "50", page: "1" }, fixture: [gitlabIssue], expected: [gitlabIssue] },
  { type: "gitlab", op: "createIssue", method: "POST", p: { project: 9, title: "Ship release", description: "Ready" }, path: "/api/v4/projects/9/issues", body: { title: "Ship release", description: "Ready" }, fixture: gitlabIssue, status: 201, expected: [gitlabIssue] },
  { type: "slack", op: "sendMessage", method: "POST", p: { channel: "C123", text: "Build ready" }, path: "/api/chat.postMessage", body: { channel: "C123", text: "Build ready" }, fixture: { ok: true, channel: "C123", ts: slackMessage.ts, message: slackMessage }, expected: [{ ok: true, channel: "C123", ts: slackMessage.ts, message: slackMessage }] },
  { type: "slack", op: "getHistory", p: { channel: "C123" }, path: "/api/conversations.history", query: { channel: "C123", limit: "15" }, fixture: { ok: true, messages: [slackMessage], has_more: false, response_metadata: { next_cursor: "" } }, expected: [slackMessage] },
  { type: "discord", op: "sendMessage", method: "POST", p: { channel: "125000000000000001", content: "Build ready" }, path: "/api/v10/channels/125000000000000001/messages", body: { allowed_mentions: { parse: [] }, content: "Build ready" }, fixture: discordMessage, expected: [discordMessage] },
  { type: "discord", op: "listMessages", p: { channel: "125000000000000001" }, path: "/api/v10/channels/125000000000000001/messages", query: { limit: "50" }, fixture: [discordMessage], expected: [discordMessage] },
  { type: "notion", op: "search", method: "POST", p: { query: "Roadmap" }, path: "/v1/search", body: { query: "Roadmap", page_size: 50 }, fixture: { object: "list", results: [notionPage], next_cursor: null, has_more: false }, expected: [notionPage] },
  { type: "notion", op: "getPage", p: { pageId: notionPage.id }, path: `/v1/pages/${notionPage.id}`, fixture: notionPage, expected: [notionPage] },
  { type: "notion", op: "appendBlocks", method: "PATCH", p: { blockId: notionPage.id, children: [notionBlock] }, path: `/v1/blocks/${notionPage.id}/children`, body: { children: [notionBlock] }, fixture: { object: "list", results: [notionBlock], has_more: false }, expected: [notionBlock] },
  { type: "airtable", op: "listRecords", p: { baseId: "app123", table: "My Table", filterByFormula: '{Name}="Ada"', view: "Main" }, path: "/v0/app123/My%20Table", query: { filterByFormula: '{Name}="Ada"', view: "Main", pageSize: "50" }, fixture: { records: [record] }, expected: [record] },
  { type: "airtable", op: "createRecord", method: "POST", p: { baseId: "app123", table: "tbl123", fields: '{"Name":"Ada","Done":false}' }, path: "/v0/app123/tbl123", body: { fields: { Name: "Ada", Done: false } }, fixture: record, expected: [record] },
  { type: "google-sheets", op: "readRange", p: { spreadsheetId: "sheet123", range: "'My Sheet'!A1:B2" }, path: "/v4/spreadsheets/sheet123/values/%27My%20Sheet%27%21A1%3AB2", query: { majorDimension: "ROWS" }, fixture: { range: "'My Sheet'!A1:B2", majorDimension: "ROWS", values: [["Ada", 42], ["Alan", 9]] }, expected: [{ range: "'My Sheet'!A1:B2", majorDimension: "ROWS", values: [["Ada", 42], ["Alan", 9]] }] },
  { type: "google-sheets", op: "appendRows", method: "POST", p: { spreadsheetId: "sheet123", range: "Sheet1!A:B", values: [["Ada", 42], ["Alan", true]] }, path: "/v4/spreadsheets/sheet123/values/Sheet1%21A%3AB:append", query: { insertDataOption: "INSERT_ROWS", valueInputOption: "RAW" }, body: { majorDimension: "ROWS", values: [["Ada", 42], ["Alan", true]] }, fixture: { spreadsheetId: "sheet123", tableRange: "Sheet1!A1:B2", updates: { updatedRange: "Sheet1!A3:B4", updatedRows: 2 } }, expected: [{ spreadsheetId: "sheet123", tableRange: "Sheet1!A1:B2", updates: { updatedRange: "Sheet1!A3:B4", updatedRows: 2 } }] },
  { type: "google-drive", op: "listFiles", p: {}, path: "/drive/v3/files", query: { q: "trashed = false", fields: "nextPageToken,files(id,name,mimeType,webViewLink,parents)", pageSize: "50" }, fixture: { kind: "drive#fileList", files: [file] }, expected: [file] },
  { type: "google-drive", op: "createFolder", method: "POST", p: { name: "Receipts", parentId: "root" }, path: "/drive/v3/files", query: { fields: "id,name,mimeType,parents,webViewLink" }, body: { mimeType: "application/vnd.google-apps.folder", name: "Receipts", parents: ["root"] }, fixture: file, expected: [file] },
  { type: "google-calendar", op: "listEvents", p: { timeMin: "2026-10-27T00:00:00Z", timeMax: "2026-10-28T00:00:00Z" }, path: "/calendar/v3/calendars/primary/events", query: { singleEvents: "true", orderBy: "startTime", timeMin: "2026-10-27T00:00:00Z", timeMax: "2026-10-28T00:00:00Z", maxResults: "50" }, fixture: { kind: "calendar#events", items: [event] }, expected: [event] },
  { type: "google-calendar", op: "createEvent", method: "POST", p: { calendarId: "ada@example.com", summary: "Standup", start: event.start.dateTime, end: event.end.dateTime, description: "Daily" }, path: "/calendar/v3/calendars/ada%40example.com/events", body: { summary: "Standup", start: event.start, end: event.end, description: "Daily" }, fixture: event, expected: [event] },
  { type: "microsoft-outlook", op: "listMessages", p: {}, path: "/v1.0/me/messages", query: { "$select": "id,subject,from,receivedDateTime,bodyPreview", "$orderby": "receivedDateTime desc", "$top": "50" }, fixture: { "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#users('ada')/messages", value: [mail] }, expected: [mail] },
  { type: "microsoft-outlook", op: "sendMail", method: "POST", p: { to: "ada@example.com, alan@example.com", subject: "Invoice", content: "Attached" }, path: "/v1.0/me/sendMail", body: { message: { body: { contentType: "Text", content: "Attached" }, subject: "Invoice", toRecipients: [{ emailAddress: { address: "ada@example.com" } }, { emailAddress: { address: "alan@example.com" } }] } }, status: 202, fixture: undefined, expected: [{ accepted: true, statusCode: 202 }] },
  { type: "microsoft-teams", op: "listMessages", p: { teamId: "team123", channelId: "19:channel@thread.tacv2" }, path: "/v1.0/teams/team123/channels/19%3Achannel%40thread.tacv2/messages", query: { "$top": "50" }, fixture: { value: [teamsMessage] }, expected: [teamsMessage] },
  { type: "microsoft-teams", op: "sendMessage", method: "POST", p: { teamId: "team123", channelId: "19:channel@thread.tacv2", content: "Build ready" }, path: "/v1.0/teams/team123/channels/19%3Achannel%40thread.tacv2/messages", body: { body: { contentType: "text", content: "Build ready" } }, fixture: teamsMessage, status: 201, expected: [teamsMessage] },
  { type: "hubspot", op: "listContacts", p: {}, path: "/crm/v3/objects/contacts", query: { properties: "email,firstname,lastname", limit: "50" }, fixture: { results: [contact], paging: { next: { after: "33452", link: "https://api.hubapi.com/crm/v3/objects/contacts?after=33452" } } }, expected: [contact] },
  { type: "hubspot", op: "createContact", method: "POST", p: { contactProperties: contact.properties }, path: "/crm/v3/objects/contacts", body: { associations: [], properties: contact.properties }, fixture: contact, status: 201, expected: [contact] },
];

const origins = {
  github: "https://api.github.com", gitlab: "https://gitlab.com", slack: "https://slack.com", discord: "https://discord.com", notion: "https://api.notion.com", airtable: "https://api.airtable.com",
  "google-sheets": "https://sheets.googleapis.com", "google-drive": "https://www.googleapis.com", "google-calendar": "https://www.googleapis.com", "microsoft-outlook": "https://graph.microsoft.com", "microsoft-teams": "https://graph.microsoft.com", hubspot: "https://api.hubapi.com",
};

for (const c of cases) test(`${c.type}: ${c.op} real request/auth/response contract`, async () => {
  let calls = 0;
  const credential = c.type === "discord" ? header("Authorization", "Bot test-token") : c.type === "gitlab" ? header("PRIVATE-TOKEN", "test-token") : structuredClone(bearer);
  const result = await run(c.type, { operation: c.op, ...c.p }, async (request) => {
    calls += 1;
    const url = new URL(request.url);
    assert.equal(url.origin, origins[c.type]);
    assert.equal(url.pathname, c.path);
    assert.deepEqual(Object.fromEntries(url.searchParams), c.query ?? {});
    assert.equal(request.method, c.method ?? "GET");
    assert.deepEqual(request.body === undefined ? undefined : JSON.parse(request.body), c.body);
    assert.equal(request.followRedirects, false);
    assert.equal(request.maxRedirects, 0);
    assert.equal(request.timeoutMs, 30000);
    assert.equal(request.maxBytes, 32 * 1024 * 1024);
    if (c.body !== undefined) assert.equal(request.headers["content-type"], "application/json");
    assert.equal(c.type === "discord" ? request.headers.Authorization : c.type === "gitlab" ? request.headers["PRIVATE-TOKEN"] : request.headers.authorization, c.type === "discord" ? "Bot test-token" : c.type === "gitlab" ? "test-token" : "Bearer test-token");
    if (c.type === "notion") assert.equal(request.headers["notion-version"], "2026-03-11");
    if (c.type === "github") { assert.equal(request.headers.accept, "application/vnd.github+json"); assert.equal(request.headers["x-github-api-version"], "2026-03-10"); }
    return reply(request.url, c.fixture, c.status);
  }, { credential });
  assert.equal(result.status, "success", JSON.stringify(result.error));
  assert.equal(calls, 1);
  assert.deepEqual(jsonOutput(result), c.expected);
  assert.ok(output(result).every((item) => item.pairedItem === 0));
});

test("inventory has 12 isomorphic integrations, every exposed operation has an independent contract fixture", () => {
  assert.equal(INTEGRATIONS.length, 12);
  assert.equal(cases.length, 26);
  for (const spec of INTEGRATIONS) {
    assert.ok(NODE_CATALOG.some((meta) => meta.type === spec.type));
    assert.ok(NODE_IMPLS.some((impl) => impl.type === spec.type));
    const meta = nodeMeta(spec.type);
    assert.equal(new Set(meta.params.map((p) => p.name)).size, meta.params.length);
    assert.ok(meta.credentials[0].required);
    for (const op of spec.operations) {
      assert.ok(cases.some((c) => `core.${c.type}` === spec.type && c.op === op.id), `${spec.type} ${op.id} lacks fixture`);
      assert.ok(op.docs.startsWith("https://"));
      for (const field of op.fields) assert.ok(meta.params.find((p) => p.name === field.parameter.name).showIf.operation.includes(op.id));
    }
  }
});
