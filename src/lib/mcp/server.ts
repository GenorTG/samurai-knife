import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { KNIFE_TOOLS, serializeKnifeToolResult } from "@/lib/mcp/tools";
import { UI_BRIDGE_TOOLS } from "@/lib/mcp/tools-ui";

export function createKnifeMcpServer(accountId: string): McpServer {
  const server = new McpServer({ name: "samurai-knife", version: "0.1.0" });

  // UI bridge tools are for agents outside the app; the built-in assistant navigates the page itself (open_tool).
  for (const tool of [...KNIFE_TOOLS, ...UI_BRIDGE_TOOLS]) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (input) => {
        try {
          const result = await tool.execute(input, { accountId });
          return { content: [{ type: "text", text: serializeKnifeToolResult(result) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text", text: message }], isError: true };
        }
      },
    );
  }

  return server;
}

/**
 * Stateless handler for one account. Private mode: the default account (MCP is unauthenticated beyond the host guard, the
 * Tailscale bind is the boundary). Public mode: the account of the request's session cookie, never a fallback; per-account
 * MCP credentials for agents outside the browser are a later phase (docs/ACCOUNTS.md).
 */
export function knifeMcpHandler(accountId: string): { fetch: (request: Request) => Promise<Response> } {
  return createMcpHandler(() => createKnifeMcpServer(accountId), { responseMode: "json" });
}
