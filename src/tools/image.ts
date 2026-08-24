import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";

const mimeTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export const imageTools: ToolDefinition[] = [
  {
    name: "image_viewer",
    description: "View a local image file.",
    inputSchema: {
      file: z.string().min(1).describe("Local image path"),
    },
    handler: async ({ file: target }, { cwd }) => {
      const file = path.isAbsolute(target as string)
        ? path.normalize(target as string)
        : path.resolve(cwd, target as string);
      const mimeType = mimeTypes[path.extname(file).toLowerCase()];
      if (!mimeType) throw new Error("Unsupported image format");

      const data = await readFile(file);
      return {
        content: [{ type: "image", data: data.toString("base64"), mimeType }],
      };
    },
  },
];
