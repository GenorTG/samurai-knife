import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { getDefaultAccount } from "@/lib/accounts/store";
import { KNIFE_TOOLS, serializeKnifeToolResult } from "@/lib/mcp/tools";
import { UI_BRIDGE_TOOLS } from "@/lib/mcp/tools-ui";

export function createKnifeMcpServer(): McpServer {
  const server = new McpServer({ name: "samurai-knife", version: "0.1.0" });

  // UI bridge tools are for agents outside the app; the built-in assistant navigates the page itself (open_tool).
  for (const tool of [...KNIFE_TOOLS, ...UI_BRIDGE_TOOLS]) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (input) => {
        try {
          // MCP is stateless and unauthenticated beyond the host guard (Tailscale bind): account-scoped tools use the default account.
          const result = await tool.execute(input, { accountId: getDefaultAccount().id });
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

export const knifeMcpHandler = createMcpHandler(() => createKnifeMcpServer(), {
  responseMode: "json",
});
