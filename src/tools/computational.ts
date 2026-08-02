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
      "Run JavaScript as a script. Put the answer in the final expression, e.g. `const x = 2; x * 3` or `const xs = [1, 2]; xs.map(x => x * 2)`. Do not use top-level `return` or rely on `console.log`. Use executable code, not pseudocode or placeholders. No Node.js APIs.",
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
        { timeout: 10_000, filename: "calculator.js" },
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
        return { result: String(value) };
      }
      return { result: value };
    },
  },
];
