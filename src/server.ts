import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "./config.js";
import { registerTools } from "./tool-registry.js";
import { tools } from "./tools/index.js";

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function handleMcp(
  request: IncomingMessage,
  response: ServerResponse,
  cwd: string,
): Promise<void> {
  const mcp = new McpServer({
    name: "minimal-node-mcp",
    version: "0.1.0",
  });
  registerTools(mcp, tools, { cwd });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  response.on("close", () => {
    void transport.close();
    void mcp.close();
  });

  await mcp.connect(transport);
  await transport.handleRequest(request, response);
}

export async function startServer(config: AppConfig) {
  await mkdir(config.cwd, { recursive: true });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/health" && request.method === "GET") {
        json(response, 200, {
          status: "ok",
          endpoint: "/mcp",
          cwd: config.cwd,
          tools: tools.map((tool) => tool.name),
        });
        return;
      }

      if (url.pathname !== "/mcp") {
        json(response, 404, { error: "Not found", endpoint: "/mcp" });
        return;
      }

      if (!["GET", "POST", "DELETE"].includes(request.method ?? "")) {
        response.setHeader("allow", "GET, POST, DELETE");
        json(response, 405, { error: "Method not allowed" });
        return;
      }

      await handleMcp(request, response, config.cwd);
    } catch (error) {
      console.error(error);
      if (!response.headersSent) {
        json(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", resolve);
  });

  return server;
}
