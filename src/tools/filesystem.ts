import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";

const resolvePath = (cwd: string, target = ".") =>
  path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);

const javascriptExtensions = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);

function normalizeJavaScriptQuotes(file: string, content: string): string {
  if (!javascriptExtensions.has(path.extname(file).toLowerCase())) return content;

  return content
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');
}

export const filesystemTools: ToolDefinition[] = [
  {
    name: "ls",
    description:
      "Preferred tool for listing files and directories; use this instead of a shell command. Paths are relative to the server workspace unless absolute.",
    inputSchema: {
      path: z.string().default(".").describe("Directory to list"),
    },
    handler: async ({ path: target }, { cwd }) => {
      const directory = resolvePath(cwd, target as string);
      const entries = await readdir(directory, { withFileTypes: true });
      const items = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(directory, entry.name);
          const info = await stat(fullPath);
          return {
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
            size_bytes: info.size,
            modified_at: info.mtime.toISOString(),
          };
        }),
      );
      return { entries: items };
    },
  },
  {
    name: "read_file",
    description:
      "Preferred tool for reading a UTF-8 text file; use this instead of a shell command. Paths are relative to the server workspace unless absolute.",
    inputSchema: {
      path: z.string().min(1).describe("File to read"),
    },
    handler: async ({ path: target }, { cwd }) =>
      readFile(resolvePath(cwd, target as string), "utf8"),
  },
  {
    name: "write_file",
    description:
      "Preferred tool for writing a UTF-8 text file; use this instead of a shell command. Creates the file and missing parent directories when needed, and closes the file before returning.",
    inputSchema: {
      path: z.string().min(1).describe("File to write"),
      content: z.string().describe("Complete file content"),
    },
    handler: async ({ path: target, content }, { cwd }) => {
      const file = resolvePath(cwd, target as string);
      const normalizedContent = normalizeJavaScriptQuotes(
        file,
        content as string,
      );
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, normalizedContent, "utf8");
      return { bytes_written: Buffer.byteLength(normalizedContent) };
    },
  },
  {
    name: "mkdir",
    description:
      "Preferred tool for creating a directory and any missing parent directories; use this instead of a shell command.",
    inputSchema: {
      path: z.string().min(1).describe("Directory to create"),
    },
    handler: async ({ path: target }, { cwd }) => {
      const directory = resolvePath(cwd, target as string);
      await mkdir(directory, { recursive: true });
      return { created: true };
    },
  },
  {
    name: "delete_file",
    description:
      "Preferred tool for deleting one file; use this instead of a shell command. It does not delete directories. If Windows reports that the file is in use, first stop the command or process holding it, then retry; this tool never forces an unsafe deletion.",
    inputSchema: {
      path: z.string().min(1).describe("File to delete"),
    },
    handler: async ({ path: target }, { cwd }) => {
      const file = resolvePath(cwd, target as string);
      const info = await stat(file);
      if (!info.isFile()) throw new Error("Target is not a file");
      await rm(file);
      return { deleted: true };
    },
  },
];
