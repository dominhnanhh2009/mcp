import vm from "node:vm";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";

const mathAliases = Object.fromEntries(
  Object.getOwnPropertyNames(Math)
    .filter((name) => name !== "constructor")
    .map((name) => [name, Math[name as keyof Math]]),
);

export const computationalTools: ToolDefinition[] = [
  {
    name: "js_calculator",
    description:
      "Evaluate JavaScript for calculations. It accepts expressions or multiple statements; the value of the final expression is returned. Supports Math APIs and direct aliases such as pow, sqrt, log, sin, PI, and E. Use semicolons between statements, and wrap an object literal in parentheses when it is the final expression. This is a calculator, not a general Node.js runner: process, require, filesystem, and network APIs are not provided.",
    inputSchema: {
      expression: z
        .string()
        .min(1)
        .describe("Example: pow(2, 10) + log(E) or Math.sqrt(81)"),
    },
    handler: ({ expression }) => {
      const value = vm.runInNewContext(expression as string, {
        Math,
        ...mathAliases,
      }, { timeout: 1_000 });
      if (typeof value === "number" && !Number.isFinite(value)) {
        return { result: String(value) };
      }
      return { result: value };
    },
  },
];
