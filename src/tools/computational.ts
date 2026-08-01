import vm from "node:vm";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";

export const computationalTools: ToolDefinition[] = [
  {
    name: "js_calculator",
    description:
      "Evaluate complete, executable JavaScript calculations. Supports expressions, variables, functions, loops, and standard built-ins such as Math. Never use ellipses (...), placeholders, omitted terms, or prose as shorthand; express repeated computation with code such as a loop. Returns the script's completion value. Node.js APIs are not provided.",
    inputSchema: {
      expression: z
        .string()
        .min(1)
        .describe(
          "Complete, syntactically valid JavaScript code to evaluate; no ellipses, placeholders, omitted terms, or prose",
        ),
    },
    handler: ({ expression }) => {
      const value = vm.runInNewContext(
        expression as string,
        Object.create(null),
        { timeout: 10_000 },
      );
      if (typeof value === "number" && !Number.isFinite(value)) {
        return { result: String(value) };
      }
      return { result: value };
    },
  },
];
