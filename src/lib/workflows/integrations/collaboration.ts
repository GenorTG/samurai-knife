import { json, text, choice, TOKEN_TYPES, type IntegrationSpec } from "./types";

export const COLLABORATION_INTEGRATIONS: IntegrationSpec[] = [
  {
    type: "core.github", label: "GitHub", baseUrl: "https://api.github.com", credentialTypes: TOKEN_TYPES,
    description: "List, get and create repository issues on GitHub.com (issues endpoints also include pull requests).",
    credentialHelp: "Bearer personal access token or OAuth2; repository Issues read/write permission as needed.",
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10" },
    operations: [
      { id: "listIssues", label: "List repository issues", method: "GET", path: "/repos/{owner}/{repository}/issues", docs: "https://docs.github.com/en/rest/issues/issues#list-repository-issues", fields: [text("owner", "Repository owner", "path"), text("repository", "Repository", "path"), choice("state", "State", "query", ["open", "closed", "all"], "open")], pagination: { mode: "page", limitKey: "per_page", maxPageSize: 100 } },
      { id: "getIssue", label: "Get an issue", method: "GET", path: "/repos/{owner}/{repository}/issues/{issueNumber}", docs: "https://docs.github.com/en/rest/issues/issues#get-an-issue", fields: [text("owner", "Repository owner", "path"), text("repository", "Repository", "path"), text("issueNumber", "Issue number", "path")] },
      { id: "createIssue", label: "Create an issue", method: "POST", path: "/repos/{owner}/{repository}/issues", docs: "https://docs.github.com/en/rest/issues/issues#create-an-issue", fields: [text("owner", "Repository owner", "path"), text("repository", "Repository", "path"), text("title", "Title", "body"), text("body", "Issue body", "body", "body", false)] },
    ],
  },
  {
    type: "core.gitlab", label: "GitLab", baseUrl: "https://gitlab.com/api/v4", credentialTypes: TOKEN_TYPES,
    description: "List and create project issues on GitLab.com; self-managed hosts are not supported in this wave.",
    credentialHelp: "PRIVATE-TOKEN header (personal token), OAuth2 or bearer access token with api/read_api scope.",
    operations: [
      { id: "listIssues", label: "List project issues", method: "GET", path: "/projects/{project}/issues", docs: "https://docs.gitlab.com/api/issues/#list-all-project-issues", fields: [text("project", "Project ID or group/project path", "path"), choice("state", "State", "query", ["opened", "closed", "all"], "opened")], pagination: { mode: "page", limitKey: "per_page", maxPageSize: 100 } },
      { id: "createIssue", label: "Create an issue", method: "POST", path: "/projects/{project}/issues", docs: "https://docs.gitlab.com/api/issues/#create-an-issue", fields: [text("project", "Project ID or group/project path", "path"), text("title", "Title", "body"), text("description", "Description", "body", "description", false)] },
    ],
  },
  {
    type: "core.slack", label: "Slack", baseUrl: "https://slack.com/api", credentialTypes: TOKEN_TYPES, envelope: "slack",
    description: "Send text messages and read channel history. History uses up to 15 messages/page for Slack's restricted-app tier.",
    credentialHelp: "Bearer bot/user token with chat:write and the appropriate channels/groups/im/mpim:history scopes.",
    operations: [
      { id: "sendMessage", label: "Send a message", method: "POST", path: "/chat.postMessage", docs: "https://docs.slack.dev/reference/methods/chat.postMessage/", fields: [text("channel", "Channel ID", "body"), text("text", "Message text", "body")] },
      { id: "getHistory", label: "Get channel history", method: "GET", path: "/conversations.history", docs: "https://docs.slack.dev/reference/methods/conversations.history/", fields: [text("channel", "Channel ID", "query")], output: "messages", pagination: { mode: "cursor", limitKey: "limit", maxPageSize: 15, cursorKey: "cursor", cursorPath: "response_metadata.next_cursor" } },
    ],
  },
  {
    type: "core.discord", label: "Discord", baseUrl: "https://discord.com/api/v10", credentialTypes: ["httpHeaderAuth"],
    description: "Send text messages and list channel messages using a bot. Mentions are disabled for outgoing messages.",
    credentialHelp: "Header auth: name Authorization, value Bot followed by your bot token; channel view/history/send permissions required.",
    headers: { "user-agent": "DiscordBot (https://github.com/GenorTG/samurai-knife, 1)" },
    operations: [
      { id: "sendMessage", label: "Send a message", method: "POST", path: "/channels/{channel}/messages", docs: "https://docs.discord.com/developers/resources/message#create-message", fields: [text("channel", "Channel ID", "path"), { ...text("content", "Message text (up to 2000 characters)", "body"), parameter: { name: "content", label: "Message text", type: "string", required: true, max: 2000 } }], body: { allowed_mentions: { parse: [] } } },
      { id: "listMessages", label: "List channel messages", method: "GET", path: "/channels/{channel}/messages", docs: "https://docs.discord.com/developers/resources/message#get-channel-messages", fields: [text("channel", "Channel ID", "path")], pagination: { mode: "before", limitKey: "limit", maxPageSize: 100, cursorKey: "before" } },
    ],
  },
  {
    type: "core.notion", label: "Notion", baseUrl: "https://api.notion.com/v1", credentialTypes: TOKEN_TYPES,
    description: "Search shared pages/data sources, get page properties, and append blocks; no database schema or page creation operations yet.",
    credentialHelp: "Bearer internal integration token or OAuth2; share the target pages with the integration, with read/insert content capabilities.",
    headers: { "notion-version": "2026-03-11" },
    operations: [
      { id: "search", label: "Search by title", method: "POST", path: "/search", docs: "https://developers.notion.com/reference/post-search", fields: [text("query", "Title search (empty lists shared content)", "body", "query", false)], output: "results", pagination: { mode: "cursor", location: "body", limitKey: "page_size", maxPageSize: 100, cursorKey: "start_cursor", cursorPath: "next_cursor" } },
      { id: "getPage", label: "Get page properties", method: "GET", path: "/pages/{pageId}", docs: "https://developers.notion.com/reference/retrieve-a-page", fields: [text("pageId", "Page ID (not URL)", "path")] },
      { id: "appendBlocks", label: "Append block children", method: "PATCH", path: "/blocks/{blockId}/children", docs: "https://developers.notion.com/reference/patch-block-children", fields: [text("blockId", "Parent page or block ID", "path"), json("children", "Blocks to append (1–100)", "children", "blocks", '[{"object":"block","type":"paragraph","paragraph":{"rich_text":[{"type":"text","text":{"content":"Hello"}}]}}]')], output: "results" },
    ],
  },
  {
    type: "core.airtable", label: "Airtable", baseUrl: "https://api.airtable.com/v0", credentialTypes: TOKEN_TYPES,
    description: "List table records and create one record per input item; batch writes and schema operations are not included.",
    credentialHelp: "Bearer personal access token or OAuth2 with data.records:read/write and access to the selected base.",
    operations: [
      { id: "listRecords", label: "List records", method: "GET", path: "/{baseId}/{table}", docs: "https://airtable.com/developers/web/api/list-records", fields: [text("baseId", "Base ID", "path"), text("table", "Table ID or name", "path"), text("filterByFormula", "Filter formula", "query", "filterByFormula", false), text("view", "View ID or name", "query", "view", false)], output: "records", pagination: { mode: "cursor", limitKey: "pageSize", maxPageSize: 100, cursorKey: "offset", cursorPath: "offset" } },
      { id: "createRecord", label: "Create a record", method: "POST", path: "/{baseId}/{table}", docs: "https://airtable.com/developers/web/api/create-records", fields: [text("baseId", "Base ID", "path"), text("table", "Table ID or name", "path"), json("fields", "Record fields", "fields", "object")] },
    ],
  },
];
