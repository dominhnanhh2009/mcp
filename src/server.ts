import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "./config.js";
import { registerTools } from "./tool-registry.js";
import { tools } from "./tools/index.js";

function addCorsHeaders(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    request.headers["access-control-request-headers"] ?? "*",
  );
  response.setHeader(
    "access-control-expose-headers",
    "Mcp-Session-Id, MCP-Protocol-Version",
  );
  response.setHeader("access-control-max-age", "86400");

  // Chromium sends this header when a public page accesses localhost/LAN.
  if (request.headers["access-control-request-private-network"] === "true") {
    response.setHeader("access-control-allow-private-network", "true");
  }
}

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
  const mcp = new McpServer(
    {
      name: "minimal-node-mcp",
      version: "1.2.0",
    },
    {
      instructions:
        "Paths are relative to the server workspace unless absolute. " +
        "Use text_editor to read, search, create, or edit files; use run_cmd only when no other tool can perform the operation. " +
        "Tool failures are returned as MCP error results.",
    },
  );
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
      addCorsHeaders(request, response);
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

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
