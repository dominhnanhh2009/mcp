import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";

const execAsync = promisify(exec);

export const commandTools: ToolDefinition[] = [
  {
    name: "run_cmd",
    description:
      "Run a shell command only when no dedicated tool provides the operation. Prefer ls, read_file, write_file, mkdir, and delete_file for filesystem work; do not use shell commands for those operations. A command may start processes that keep files open on Windows, preventing safe deletion until those processes exit. No sandboxing is applied.",
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
        return {
          exit_code: 0,
          ...(stdout ? { stdout } : {}),
          ...(stderr ? { stderr } : {}),
        };
      } catch (error) {
        const result = error as Error & {
          code?: number | string;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
        };
        const exitCode =
          typeof result.code === "number" ? result.code : null;
        return {
          exit_code: exitCode,
          ...(typeof result.code === "string"
            ? { error_code: result.code }
            : {}),
          ...(result.stdout ? { stdout: result.stdout } : {}),
          ...(result.stderr ? { stderr: result.stderr } : {}),
          ...(result.killed ? { killed: true } : {}),
          ...(!result.stderr && !result.stdout
            ? {
                error: result.killed
                  ? "Command timed out"
                  : "Command execution failed without output",
              }
            : {}),
        };
      }
    },
  },
];
