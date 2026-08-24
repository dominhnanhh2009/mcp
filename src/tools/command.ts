import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";

const execAsync = promisify(exec);

function describeShell(): { name: string; examples: string } {
  if (process.platform === "win32") {
    const commandProcessor = process.env.ComSpec || "cmd.exe";
    return {
      name: `Windows ${path.basename(commandProcessor)}`,
      examples:
        "listing (`dir`), creating directories (`mkdir dir`), deleting (`del file`), copying (`copy a b`), moving, or renaming (`move a b`)",
    };
  }

  return {
    name: "/bin/sh",
    examples:
      "listing (`ls`), creating directories (`mkdir dir`), deleting (`rm file`), copying (`cp a b`), moving, or renaming (`mv a b`)",
  };
}

const shellDescription = describeShell();

export const commandTools: ToolDefinition[] = [
  {
    name: "run_cmd",
    description:
      `Run an unsandboxed command with ${shellDescription.name}. NEVER use this tool when another provided tool can perform the operation. Use it only when all other tools are unsuitable. ` +
      "NEVER use shell file-reading or file-writing commands such as `cat file`, `echo text > file`, `echo text >> file`, or the `>>` redirection operator; use `read_file`, `create_file`, or `edit_file` instead. " +
      `Use it for shell-only operations such as ${shellDescription.examples}.`,
    inputSchema: {
      command: z.string().min(1).describe("Shell command to execute"),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(300_000)
        .default(30_000)
        .describe("Maximum run time in milliseconds"),
    },
    handler: async ({ command, timeout_ms }, { cwd }) => {
      try {
        const { stdout, stderr } = await execAsync(command as string, {
          cwd,
          timeout: timeout_ms as number,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        });
        if (!stdout && !stderr) {
          return "(empty output)";
        }
        if (stdout && stderr) {
          return `${stdout}\n[stderr]:\n${stderr}`;
        }
        return stdout || stderr;
      } catch (error) {
        const result = error as Error & {
          code?: number | string;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
        };
        const exitCode = typeof result.code === "number" ? result.code : 1;
        const detail =
          result.stderr ||
          result.stdout ||
          (result.killed ? "Command timed out" : result.message);
        return `[exit code: ${exitCode}]\n${detail}`;
      }
    },
  },
];
