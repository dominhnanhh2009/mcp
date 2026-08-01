import vm from "node:vm";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";

export const computationalTools: ToolDefinition[] = [
  {
    name: "js_calculator",
    description:
      "Evaluate complete, executable JavaScript calculations. Supports expressions, variables, functions, loops, and standard built-ins such as Math. Do not substitute pseudocode, placeholders, or omitted computation for executable code; implement repeated computation with valid JavaScript such as a loop. JavaScript syntax such as string literals and spread/rest remains valid. Returns the script's completion value. Node.js APIs are not provided.",
    inputSchema: {
      expression: z
        .string()
        .min(1)
        .describe(
          "Complete, syntactically valid JavaScript code; do not replace executable logic with pseudocode, placeholders, or omitted computation",
        ),
    },
    handler: ({ expression }) => {
      const value = vm.runInNewContext(
        expression as string,
        Object.create(null),
        { timeout: 10_000, filename: "calculator.js" },
      );
      if (typeof value === "number" && !Number.isFinite(value)) {
        return { result: String(value) };
      }
      return { result: value };
    },
  },
];
