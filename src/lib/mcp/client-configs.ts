/**
 * Ready-made MCP client settings for one key on an account's personal URL (docs/MCP.md "Connecting"), shown once on
 * /account right after the key is created. Syntax checked against `openclaw mcp add --help` (`--header key=value`),
 * `claude mcp add --transport http <name> <url> --header "Name: value"` and Cursor's `mcp.json` (`url` + `headers`).
 */
export type McpClientId = "openclaw" | "claude" | "cursor";

export function mcpClientConfigs(url: string, key: string): { id: McpClientId; text: string }[] {
  return [
    { id: "openclaw", text: `openclaw mcp add samurai-knife --url ${url} --transport streamable-http --header "Authorization=Bearer ${key}"` },
    { id: "claude", text: `claude mcp add --transport http samurai-knife ${url} --header "Authorization: Bearer ${key}"` },
    { id: "cursor", text: JSON.stringify({ mcpServers: { "samurai-knife": { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2) },
  ];
}
