import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toolAllowed, type KnifeToolContext } from "@/lib/mcp/define";
import { KNIFE_TOOLS, serializeKnifeToolResult } from "@/lib/mcp/tools";
import { UI_BRIDGE_TOOLS } from "@/lib/mcp/tools-ui";

/** One server per request, for one caller: only the tools its role may use are registered (listed and callable). */
export function createKnifeMcpServer(ctx: KnifeToolContext): McpServer {
  const server = new McpServer({ name: "samurai-knife", version: "0.1.0" });

  // UI bridge tools are for agents outside the app; the built-in assistant navigates the page itself (open_tool).
  for (const tool of [...KNIFE_TOOLS, ...UI_BRIDGE_TOOLS].filter((candidate) => toolAllowed(candidate, ctx))) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (input) => {
        try {
          const result = await tool.execute(input, ctx);
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
 * Stateless handler for one caller, resolved by the route (docs/MCP.md "Connecting"): the account of an MCP key (both
 * modes), else in private mode the default account (the Tailscale bind is the boundary). Every tool runs as that account.
 */
export function knifeMcpHandler(ctx: KnifeToolContext): { fetch: (request: Request) => Promise<Response> } {
  return createMcpHandler(() => createKnifeMcpServer(ctx), { responseMode: "json" });
}
