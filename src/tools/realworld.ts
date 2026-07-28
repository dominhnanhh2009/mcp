import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";

export const realworldTools: ToolDefinition[] = [
  {
    name: "get_current_time",
    description:
      "Get the current date and time in an LLM-friendly format, optionally in a specific IANA timezone.",
    inputSchema: {
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone, for example Asia/Bangkok or UTC"),
    },
    handler: ({ timezone }) => {
      const now = new Date();
      const requestedZone = timezone as string | undefined;
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: requestedZone,
        dateStyle: "full",
        timeStyle: "long",
        hourCycle: "h23",
      });
      const resolvedZone = formatter.resolvedOptions().timeZone;
      return {
        human_readable: formatter.format(now),
        timezone: resolvedZone,
        iso_utc: now.toISOString(),
      };
    },
  },
];
