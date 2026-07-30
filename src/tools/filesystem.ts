import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";

const resolvePath = (cwd: string, target = ".") =>
  path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);

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
      return { path: directory, entries: items };
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
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content as string, "utf8");
      return { path: file, bytes_written: Buffer.byteLength(content as string) };
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
      return { path: directory, created: true };
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
      if (!info.isFile()) throw new Error(`Not a file: ${file}`);
      await rm(file);
      return { path: file, deleted: true };
    },
  },
];
