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
      const formatter = new Intl.DateTimeFormat("sv-SE", {
        timeZone: requestedZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "longOffset",
      });
      const parts = Object.fromEntries(
        formatter
          .formatToParts(now)
          .filter((part) => part.type !== "literal")
          .map((part) => [part.type, part.value]),
      );
      const timeZoneName = parts.timeZoneName ?? "GMT";
      const offset = timeZoneName === "GMT"
        ? "Z"
        : timeZoneName.replace("GMT", "");
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
    },
  },
];
