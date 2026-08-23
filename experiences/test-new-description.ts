import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execAsync = promisify(exec);

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

  const nonOverlapping: Match[] = [];
  for (const match of ranked) {
    const overlaps = nonOverlapping.some(
      (existing) =>
        Math.max(existing.start, match.start) <
        Math.min(existing.end, match.end),
    );
    if (!overlaps) {
      nonOverlapping.push(match);
    }
  }

  return nonOverlapping;
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

async function executeTextEditor(
  cwd: string,
  args: { file: string; search_text?: string; replacement?: string },
) {
  const file = path.isAbsolute(args.file)
    ? path.normalize(args.file)
    : path.resolve(cwd, args.file);

  if (args.search_text === undefined) {
    if (args.replacement === undefined) {
      const content = await readFile(file, "utf8");
      return content;
    }

    const normalizedReplacement = normalizeJavaScriptQuotes(
      file,
      args.replacement,
    );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, normalizedReplacement, "utf8");
    return JSON.stringify({
      bytes_written: Buffer.byteLength(normalizedReplacement),
    });
  }

  const query = args.search_text;
  const original = await readFile(file, "utf8");
  const matches = rankMatches(original, query);
  const percentage = matches[0] ? matchPercentage(matches[0], query.length) : 0;

  if (percentage < 90) {
    return JSON.stringify({
      error: `Best match is ${percentage}%, below the required 90%; no changes made`,
    });
  }

  if (args.replacement === undefined) {
    return JSON.stringify({
      success: true,
      matches: matches
        .filter((match) => matchPercentage(match, query.length) >= 90)
        .slice(0, 3)
        .map((match) => ({
          match_percentage: matchPercentage(match, query.length),
          review: reviewAround(original, match.start, match.end),
        })),
    });
  }

  const tiedBest = matches.filter(
    (match) => matchPercentage(match, query.length) === percentage,
  );
  if (tiedBest.length > 1) {
    return JSON.stringify({
      error: `Found ${tiedBest.length} matches tied at ${percentage}%; no changes made`,
    });
  }

  const match = matches[0]!;
  const normalizedReplacement = normalizeJavaScriptQuotes(
    file,
    args.replacement,
  );
  const updated =
    original.slice(0, match.start) +
    normalizedReplacement +
    original.slice(match.end);
  await writeFile(file, updated, "utf8");
  return JSON.stringify({
    success: true,
    match_percentage: percentage,
    review: reviewAround(
      updated,
      match.start,
      match.start + normalizedReplacement.length,
    ),
  });
}

async function executeRunCmd(cwd: string, command: string, timeoutMs = 30000) {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return JSON.stringify({
      exit_code: 0,
      ...(stdout ? { stdout } : {}),
      ...(stderr ? { stderr } : {}),
    });
  } catch (error: any) {
    return JSON.stringify({
      exit_code: typeof error.code === "number" ? error.code : 1,
      ...(error.stdout ? { stdout: error.stdout } : {}),
      ...(error.stderr ? { stderr: error.stderr } : {}),
    });
  }
}

// Updated tools schema exactly from the new filesystem.ts
const TOOLS_SCHEMA = [
  {
    type: "function",
    function: {
      name: "text_editor",
      description:
        "Read, create, search, and edit UTF-8 files. read {file}; search {file, search_text: content to search}; edit {file, search_text: old_text, replacement: new_text}; write {file, replacement: content to write}.",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            minLength: 1,
            description: "Target file path",
          },
          search_text: {
            description:
              "Content to find in the file. Never put new file content here.",
            type: "string",
            minLength: 1,
          },
          replacement: {
            description: "Replacement text; do not include to read",
            type: "string",
          },
        },
        required: ["file"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_cmd",
      description:
        "Run an unsandboxed command with Windows cmd.exe. NEVER use this tool when another provided tool can perform the operation. Use it only when all other tools are unsuitable. NEVER use shell file-reading or file-writing commands such as `cat file`, `echo text > file`, `echo text >> file`, or the `>>` redirection operator; use `text_editor` to read, create, or edit files instead.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            minLength: 1,
            description: "Shell command to execute",
          },
          timeout_ms: {
            default: 30000,
            description: "Maximum run time in milliseconds",
            type: "integer",
          },
        },
        required: ["command"],
      },
    },
  },
];

const SYSTEM_PROMPT =
  "Paths are relative to the server workspace unless absolute. " +
  "ALWAYS use text_editor to read, search, create, or edit files. Use run_cmd ONLY when no other tool can perform the operation. " +
  "For existing files, prefer the smallest targeted replacement and preserve unrelated content, formatting, and structure. Use whole-file writes only for new files or intentional full rewrites; they create missing files and directories. After an edit, verify with the returned review; NEVER reread the whole file just to verify it. " +
  "Tool failures are returned as MCP error results.";

async function runPromptTest(testName: string, prompt: string) {
  const rootDir = process.cwd();
  const cwd = path.resolve(rootDir, "experiences", "sandbox", `test_${testName}`);
  await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true });

  console.log(`\n================================================================`);
  console.log(`🧪 KIỂM THỬ VỚI CẬP NHẬT MỚI CỦA PROJECT: ${testName}`);
  console.log(`📂 Sandbox: ${cwd}`);
  console.log(`================================================================`);

  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  let turn = 0;
  const maxTurns = 8;

  while (turn < maxTurns) {
    turn++;
    console.log(`\n[Turn ${turn}] Gửi request tới llama-server...`);

    const payload = {
      model: "qwen3.5-4b",
      stream: false,
      temperature: 0,
      repeat_penalty: 1.0,
      reasoning_control: true,
      chat_template_kwargs: { enable_thinking: true },
      thinking_budget_tokens: 512,
      max_tokens: 2048,
      messages,
      tools: TOOLS_SCHEMA,
    };

    let response: Response;
    try {
      response = await fetch("http://localhost:3333/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err: any) {
      console.error(`❌ Fetch error: ${err.message}`);
      break;
    }

    if (!response.ok) {
      const errText = await response.text();
      console.error(`❌ HTTP ${response.status}: ${errText}`);
      break;
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) break;

    const msg = choice.message;
    messages.push(msg);

    if (msg.reasoning_content) {
      console.log(`💭 [Thinking]: ${msg.reasoning_content.slice(0, 150)}...`);
    }

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log(`🏁 [Turn ${turn}] Model kết thúc hội thoại.`);
      if (msg.content) console.log(`🗣️ [Assistant]: ${msg.content.slice(0, 200)}...`);
      break;
    }

    for (const toolCall of msg.tool_calls) {
      const fnName = toolCall.function.name;
      let fnArgs: any = {};
      try {
        fnArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        fnArgs = toolCall.function.arguments;
      }

      let actionDesc = "";
      if (fnName === "text_editor") {
        if (fnArgs.search_text !== undefined && fnArgs.replacement !== undefined) {
          actionDesc = `EDIT/REPLACE (search_text length: ${fnArgs.search_text.length})`;
        } else if (fnArgs.search_text === undefined && fnArgs.replacement !== undefined) {
          actionDesc = `WRITE_ALL (replacement length: ${fnArgs.replacement.length})`;
        } else if (fnArgs.search_text === undefined && fnArgs.replacement === undefined) {
          actionDesc = `READ_ALL`;
        } else if (fnArgs.search_text !== undefined && fnArgs.replacement === undefined) {
          actionDesc = `SEARCH ("${fnArgs.search_text.slice(0, 30)}")`;
        }
      } else if (fnName === "run_cmd") {
        actionDesc = `RUN_CMD("${fnArgs.command}")`;
      }

      console.log(`   🛠️ Turn ${turn} Tool: [${actionDesc}]`);

      let toolResult = "";
      try {
        if (fnName === "text_editor") {
          toolResult = await executeTextEditor(cwd, fnArgs);
        } else if (fnName === "run_cmd") {
          toolResult = await executeRunCmd(cwd, fnArgs.command, fnArgs.timeout_ms);
        } else {
          toolResult = JSON.stringify({ error: `Tool ${fnName} not mocked` });
        }
      } catch (err: any) {
        toolResult = JSON.stringify({ error: err.message });
      }

      console.log(`   📥 Result: ${toolResult.slice(0, 200)}`);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: fnName,
        content: toolResult,
      });
    }
  }
}

async function main() {
  const prompt1 = `hãy tạo 1 file nodejs tên "fact.js":
 - chứa 1 class FactorizedNumber:
  + được biểu diện nội bộ là 1 map/object KV, với K là các thừa số nguyên tố và V tương ứng là số mũ của thừa số đó
  + có hàm construct cho phép khởi tạo từ 1 số nguyên
  + hàm render trả về 1 string dạng "k1^v1 k_2^v_2 k3^v3 ... kn^vn"

Sau khi tạo xong fact.js, hãy tạo file "test.js" để kiểm thử FactorizedNumber rồi chạy lệnh "node test.js" bằng run_cmd để xác nhận kết quả.`;

  await runPromptTest("fact_with_testfile", prompt1);
}

main().catch(console.error);
