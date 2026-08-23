import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
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

// 1. read_file
async function executeReadFile(cwd: string, args: { file: string }) {
  const file = path.isAbsolute(args.file)
    ? path.normalize(args.file)
    : path.resolve(cwd, args.file);
  try {
    const content = await readFile(file, "utf8");
    return content;
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

// 2. create_file
async function executeCreateFile(cwd: string, args: { file: string; content: string }) {
  const file = path.isAbsolute(args.file)
    ? path.normalize(args.file)
    : path.resolve(cwd, args.file);
  const normalizedContent = normalizeJavaScriptQuotes(file, args.content);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, normalizedContent, "utf8");
  return JSON.stringify({
    success: true,
    file: path.relative(cwd, file),
    bytes_written: Buffer.byteLength(normalizedContent),
  });
}

// 3. edit_file (targeted search & replace)
async function executeEditFile(
  cwd: string,
  args: { file: string; search_text: string; replacement: string },
) {
  const file = path.isAbsolute(args.file)
    ? path.normalize(args.file)
    : path.resolve(cwd, args.file);

  let original = "";
  try {
    original = await readFile(file, "utf8");
  } catch (err: any) {
    return JSON.stringify({ error: `File not found: ${err.message}` });
  }

  const query = args.search_text;
  const matches = rankMatches(original, query);
  const percentage = matches[0] ? matchPercentage(matches[0], query.length) : 0;

  if (percentage < 90) {
    return JSON.stringify({
      error: `Best match is ${percentage}%, below the required 90%; no changes made`,
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

// 4. run_cmd
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

// Separate distinct tools schema
const SPLIT_TOOLS_SCHEMA = [
  {
    type: "function",
    function: {
      name: "create_file",
      description:
        "Create a new UTF-8 file with the given content. Use this tool ONLY when creating a new file.",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "Target file path to create",
          },
          content: {
            type: "string",
            description: "The full initial text content for the new file",
          },
        },
        required: ["file", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Edit an existing file by replacing a specific target snippet with new text. Use this tool to modify existing code.",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "Target file path to edit",
          },
          search_text: {
            type: "string",
            description: "Exact existing code snippet in the file to replace",
          },
          replacement: {
            type: "string",
            description: "New code snippet to replace search_text with",
          },
        },
        required: ["file", "search_text", "replacement"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full text content of an existing file.",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "Target file path to read",
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
      description: "Run a shell command with Windows cmd.exe.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
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
  "Use `create_file` to create new files, `edit_file` to modify existing files with targeted changes, and `read_file` to read files. Use `run_cmd` ONLY to execute shell commands. " +
  "Always prefer `edit_file` for existing files to make targeted edits and preserve unrelated structure. " +
  "Tool failures are returned as error results.";

const USER_PROMPT = `hãy tạo 1 file nodejs tên "fact.js":
 - chứa 1 class FactorizedNumber:
  + được biểu diện nội bộ là 1 map/object KV, với K là các thừa số nguyên tố và V tương ứng là số mũ của thừa số đó
  + có hàm construct cho phép khởi tạo từ 1 số nguyên
  + hàm render trả về 1 string dạng "k1^v1 k_2^v_2 k3^v3 ... kn^vn"

Sau khi tạo xong fact.js, hãy tạo file "test.js" để kiểm thử FactorizedNumber rồi chạy lệnh "node test.js" bằng run_cmd để xác nhận kết quả.`;

async function main() {
  const rootDir = process.cwd();
  const cwd = path.resolve(rootDir, "experiences", "sandbox", "test_split_tools");
  await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true });

  console.log("================================================================");
  console.log("🔍 THỬ NGHIỆM VỚI BỘ TOOL TÁCH BIỆT: create_file & edit_file");
  console.log(`📂 Sandbox CWD: ${cwd}`);
  console.log("================================================================\n");

  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: USER_PROMPT },
  ];

  let turn = 0;
  const maxTurns = 8;

  while (turn < maxTurns) {
    turn++;
    console.log(`\n------------------------------------------------------------`);
    console.log(`🔄 [Turn ${turn}] Gửi request tới llama-server (/v1/chat/completions)...`);
    console.log(`------------------------------------------------------------`);

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
      tools: SPLIT_TOOLS_SCHEMA,
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
      console.log(`💭 [Thinking]:\n${msg.reasoning_content.trim()}`);
    }

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log(`🏁 [Turn ${turn}] Model đã kết thúc hội thoại.`);
      if (msg.content) console.log(`🗣️ [Assistant]:\n${msg.content.trim()}`);
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

      console.log(`\n🛠️ [Tool Call ID: ${toolCall.id}]`);
      console.log(`   Tool Name: 👉 ${fnName.toUpperCase()} 👈`);
      console.log(`   Args:`, JSON.stringify(fnArgs, null, 2));

      let toolResult = "";
      try {
        if (fnName === "create_file") {
          toolResult = await executeCreateFile(cwd, fnArgs);
        } else if (fnName === "edit_file") {
          toolResult = await executeEditFile(cwd, fnArgs);
        } else if (fnName === "read_file") {
          toolResult = await executeReadFile(cwd, fnArgs);
        } else if (fnName === "run_cmd") {
          toolResult = await executeRunCmd(cwd, fnArgs.command, fnArgs.timeout_ms);
        } else {
          toolResult = JSON.stringify({ error: `Tool ${fnName} not recognized` });
        }
      } catch (err: any) {
        toolResult = JSON.stringify({ error: err.message });
      }

      console.log(`   📥 [Result]: ${toolResult.slice(0, 300)}`);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: fnName,
        content: toolResult,
      });
    }
  }
}

main().catch(console.error);
