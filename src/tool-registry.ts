import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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

function isDirectResult(value: unknown): value is CallToolResult {
  return (
    value !== null &&
    typeof value === "object" &&
    "content" in value &&
    Array.isArray(value.content)
  );
}

function asResult(value: unknown): CallToolResult {
  if (value === undefined || value === null) {
    return { content: [{ type: "text", text: "" }] };
  }
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
        ? String(value)
        : JSON.stringify(value);
  return { content: [{ type: "text", text }] };
}

function asErrorResult(error: unknown): CallToolResult {
  const errorLike: { message: string; code?: unknown; stack?: unknown } | undefined =
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
      ? (error as { message: string; code?: unknown; stack?: unknown })
      : undefined;

  if (!errorLike) {
    return {
      isError: true,
      content: [{ type: "text", text: String(error) }],
    };
  }

  const code =
    "code" in errorLike && errorLike.code !== undefined
      ? String(errorLike.code)
      : undefined;
  const friendlyMessages: Record<string, string> = {
    EACCES: "Permission denied",
    EEXIST: "File or directory already exists",
    EISDIR: "Expected a file but found a directory",
    EMFILE: "Too many open files",
    ENOENT: "File or directory does not exist",
    ENOTDIR: "A path component is not a directory",
    ENOTEMPTY: "Directory is not empty",
    EPERM: "Operation is not permitted",
    EJSUNDEFINED:
      "Script produced undefined. Put the answer in the final expression; do not rely on console.log",
  };
  // Node filesystem errors append the path and syscall after a comma. The caller
  // already has the path in the tool arguments, so keep only the useful reason.
  const systemMessage = code
    ? (errorLike.message.split(",", 1)[0] ?? errorLike.message)
    : errorLike.message;
  const message = code ? (friendlyMessages[code] ?? systemMessage) : systemMessage;
  const stack =
    "stack" in errorLike && typeof errorLike.stack === "string"
      ? errorLike.stack
      : undefined;
  const text = code ? `${message} (${code})` : (stack ?? message);

  return {
    isError: true,
    content: [{ type: "text", text }],
  };
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
          const result = await tool.handler(input, context);
          return isDirectResult(result) ? result : asResult(result);
        } catch (error) {
          return asErrorResult(error);
        }
      },
    );
  }

  // Strip "$schema" from all tool definitions in tools/list to avoid wasting LLM context tokens.
  const protocol = server.server as unknown as {
    _requestHandlers?: Map<
      string,
      (
        request: unknown,
        extra: unknown,
      ) => Promise<{ tools: Array<{ inputSchema?: Record<string, unknown>; [key: string]: unknown }> }>
    >;
  };
  const originalListHandler = protocol._requestHandlers?.get("tools/list");
  if (originalListHandler) {
    server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const result = await originalListHandler(request, extra);
      if (result && Array.isArray(result.tools)) {
        return {
          ...result,
          tools: result.tools.map((tool: { inputSchema?: Record<string, unknown>; [key: string]: unknown }) => {
            if (tool.inputSchema) {
              const { $schema, ...cleanSchema } = tool.inputSchema;
              return { ...tool, inputSchema: cleanSchema };
            }
            return tool;
          }),
        };
      }
      return result;
    });
  }
}
