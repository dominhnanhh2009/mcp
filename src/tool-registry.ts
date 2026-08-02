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
          return asResult(await tool.handler(input, context));
        } catch (error) {
          return asErrorResult(error);
        }
      },
    );
  }
}
