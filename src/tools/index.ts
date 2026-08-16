import type { ToolDefinition } from "../tool-registry.js";
import { commandTools } from "./command.js";
import { computationalTools } from "./computational.js";
import { filesystemTools } from "./filesystem.js";
import { imageTools } from "./image.js";
import { realworldTools } from "./realworld.js";

// Add or remove a tool module here. Each tool only needs metadata, a Zod
// inputSchema, and a handler.
export const tools: ToolDefinition[] = [
  ...filesystemTools,
  ...imageTools,
  ...commandTools,
  ...computationalTools,
  ...realworldTools,
];

export function withAdditionalTools(
  additional: ToolDefinition[] = [],
): ToolDefinition[] {
  return [...tools, ...additional];
}
