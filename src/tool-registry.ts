import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";

export interface ToolContext {
  cwd: string;
}

export interface ToolDefinition<TInput extends ZodRawShape = ZodRawShape> {
  name: string;
  title?: string;
  description: string;
  inputSchema: TInput;
  handler: (
    input: { [K in keyof TInput]: unknown },
    context: ToolContext,
  ) => unknown | Promise<unknown>;
}

function asResult(value: unknown): CallToolResult {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: text ?? "null" }] };
}

export function registerTools(
  server: McpServer,
  tools: ToolDefinition[],
  context: ToolContext,
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (input) => {
        try {
          return asResult(await tool.handler(input, context));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            isError: true,
            content: [{ type: "text", text: message }],
          };
        }
      },
    );
  }
}
