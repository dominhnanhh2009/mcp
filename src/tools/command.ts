import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";

const execAsync = promisify(exec);

export const commandTools: ToolDefinition[] = [
  {
    name: "run_cmd",
    description:
      "Run a shell command in the server workspace and return stdout, stderr, and exit information. No sandboxing is applied.",
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
        return { exit_code: 0, stdout, stderr };
      } catch (error) {
        const result = error as Error & {
          code?: number | string;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
        };
        return {
          exit_code: result.code ?? null,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          killed: result.killed ?? false,
          error: result.message,
        };
      }
    },
  },
];
