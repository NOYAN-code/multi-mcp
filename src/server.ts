import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer() {
  const server = new McpServer({
    name: "Multi MCP",
    version: "0.1.0"
  });

  server.registerTool(
    "ping",
    {
      description: "Health check. Returns a short message to confirm the server works.",
      inputSchema: { text: z.string().max(100).optional() }
    },
    async ({ text }) => {
      return {
        content: [
          {
            type: "text",
            text: `Multi MCP is working. You said: ${text ?? "nothing"}`
          }
        ]
      };
    }
  );

  return server;
}

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    return createMcpHandler(createServer)(request, env as any, ctx);
  }
};
