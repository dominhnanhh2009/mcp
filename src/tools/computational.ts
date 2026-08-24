import vm from "node:vm";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";

function normalizeJavaScriptQuotes(source: string): string {
  return source
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');
}

export const computationalTools: ToolDefinition[] = [
  {
    name: "js_calculator",
    description:
      "Evaluate JavaScript without Node.js APIs. Put the answer in the final expression, for example `\"hello\".toUpperCase()`. To return multiple values at once, combine them into an object (recommended), an array, or a string; for example `({ sum: 2 + 3, product: 2 * 3 })` or `const xs = [1, 2]; ({ doubled: xs.map(x => x * 2), count: xs.length })`. NEVER use console.log or top-level return.",
    inputSchema: {
      expression: z
        .string()
        .min(1)
        .describe(
          "JavaScript source whose final expression is the answer",
        ),
    },
    handler: ({ expression }) => {
      const source = normalizeJavaScriptQuotes(expression as string);
      const value = vm.runInNewContext(
        source,
        Object.create(null),
        { timeout: 60_000, filename: "calculator.js" },
      );
      if (value === undefined) {
        throw Object.assign(
          new Error(
            "Script produced undefined. Put the answer in the final expression; do not rely on console.log.",
          ),
          { code: "EJSUNDEFINED" },
        );
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        return String(value);
      }
      return typeof value === "object" && value !== null ? value : String(value);
    },
  },
];
