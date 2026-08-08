import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";

const resolvePath = (cwd: string, target = ".") =>
  path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);

const javascriptExtensions = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);

function normalizeJavaScriptQuotes(file: string, content: string): string {
  if (!javascriptExtensions.has(path.extname(file).toLowerCase())) return content;

  return content
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');
}

type Match = { start: number; end: number; distance: number };

function rankMatches(source: string, query: string): Match[] {
  const text = source.toLocaleLowerCase();
  const pattern = query.toLocaleLowerCase();
  const width = text.length + 1;
  let distances = Array.from({ length: width }, () => 0);
  let starts = Array.from({ length: width }, (_, index) => index);

  for (let row = 1; row <= pattern.length; row += 1) {
    const nextDistances = new Array<number>(width);
    const nextStarts = new Array<number>(width);
    nextDistances[0] = row;
    nextStarts[0] = 0;

    for (let column = 1; column < width; column += 1) {
      const candidates = [
        {
          distance:
            distances[column - 1]! +
            (pattern[row - 1] === text[column - 1] ? 0 : 1),
          start: starts[column - 1]!,
        },
        { distance: distances[column]! + 1, start: starts[column]! },
        {
          distance: nextDistances[column - 1]! + 1,
          start: nextStarts[column - 1]!,
        },
      ];
      candidates.sort(
        (left, right) =>
          left.distance - right.distance || right.start - left.start,
      );
      nextDistances[column] = candidates[0]!.distance;
      nextStarts[column] = candidates[0]!.start;
    }

    distances = nextDistances;
    starts = nextStarts;
  }

  const matches = new Map<string, Match>();
  for (let end = 1; end < width; end += 1) {
    const start = starts[end]!;
    if (end <= start) continue;
    const match = { start, end, distance: distances[end]! };
    const key = `${start}:${end}`;
    const existing = matches.get(key);
    if (!existing || match.distance < existing.distance) matches.set(key, match);
  }

  const similarity = (match: Match) =>
    1 - match.distance / Math.max(pattern.length, match.end - match.start);
  const ranked = [...matches.values()].sort(
    (left, right) =>
      similarity(right) - similarity(left) || left.start - right.start,
  );
  return ranked;
}

function matchPercentage(match: Match, queryLength: number): number {
  const similarity =
    1 - match.distance / Math.max(queryLength, match.end - match.start);
  return Math.round(similarity * 10_000) / 100;
}

function reviewAround(content: string, start: number, end: number): string {
  const contextLength = 50;
  return content.slice(
    Math.max(0, start - contextLength),
    Math.min(content.length, end + contextLength),
  );
}

export const filesystemTools: ToolDefinition[] = [
  {
    name: "text_editor",
    description:
      "The dedicated tool for all file-content work: read, create, search, and edit UTF-8 files. Always use this tool for file contents. select targets text; an empty select targets the whole file. Omit replacement to read; provide it to write. Whole-file writes create missing files and directories.",
    inputSchema: {
      file: z
        .string()
        .min(1)
        .describe("Target file path"),
      select: z
        .string()
        .describe("Text to select; an empty string selects the whole file"),
      replacement: z
        .string()
        .optional()
        .describe("Text to replace the selection; omit to read"),
    },
    handler: async ({ file: target, select, replacement }, { cwd }) => {
      const file = resolvePath(cwd, target as string);
      if (select === "") {
        if (replacement === undefined) return readFile(file, "utf8");

        const normalizedReplacement = normalizeJavaScriptQuotes(
          file,
          replacement as string,
        );
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, normalizedReplacement, "utf8");
        return { bytes_written: Buffer.byteLength(normalizedReplacement) };
      }

      const query = select as string;
      const original = await readFile(file, "utf8");
      const matches = rankMatches(original, query);
      const percentage = matches[0]
        ? matchPercentage(matches[0], query.length)
        : 0;

      if (percentage < 90) {
        throw new Error(
          `Best match is ${percentage}%, below the required 90%; no changes made`,
        );
      }
      if (replacement === undefined) {
        return {
          success: true,
          matches: matches
            .filter((match) => matchPercentage(match, query.length) >= 90)
            .slice(0, 3)
            .map((match) => ({
              match_percentage: matchPercentage(match, query.length),
              review: reviewAround(original, match.start, match.end),
            })),
        };
      }

      const tiedBest = matches.filter(
        (match) => matchPercentage(match, query.length) === percentage,
      );
      if (tiedBest.length > 1) {
        throw new Error(
          `Found ${tiedBest.length} matches tied at ${percentage}%; no changes made`,
        );
      }

      const match = matches[0]!;
      const normalizedReplacement = normalizeJavaScriptQuotes(
        file,
        replacement as string,
      );
      const updated =
        original.slice(0, match.start) +
        normalizedReplacement +
        original.slice(match.end);
      await writeFile(file, updated, "utf8");
      return {
        success: true,
        match_percentage: percentage,
        review: reviewAround(
          updated,
          match.start,
          match.start + normalizedReplacement.length,
        ),
      };
    },
  },
];
