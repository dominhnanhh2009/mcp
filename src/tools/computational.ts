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
      "Evaluate a JavaScript math expression. Supports Math APIs plus direct aliases such as pow, sqrt, log, sin, PI, and E.",
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
        return { expression, result: String(value) };
      }
      return { expression, result: value };
    },
  },
];
