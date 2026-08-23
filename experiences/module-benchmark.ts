import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execAsync = promisify(exec);

// Exact same logic as src/tools/filesystem.ts
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
        "Run an unsandboxed command with Windows cmd.exe. NEVER use this tool when another provided tool can perform the operation. Use it only when all other tools are unsuitable. NEVER use shell file-reading or file-writing commands such as `cat file`, `echo text > file`, `echo text >> file`, or the `>>` redirection operator; use `text_editor` to read, create, or edit files instead. Use it for shell-only operations such as listing (`dir`), creating directories (`mkdir dir`), deleting (`del file`), copying (`copy a b`), moving, or renaming (`move a b`).",
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

interface ModulePair {
  pairId: number;
  title: string;
  files: Record<string, string>;
  side1Prompt: string; // Direct module notification
  side2Prompt: string; // Emergent node run & fix
}

const PAIRS: ModulePair[] = [
  {
    pairId: 1,
    title: "Mismatched CJS/ESM Export",
    files: {
      "math_utils.js": `// Math Utility Module
export function add(a, b) {
  return a + b;
}
export function subtract(a, b) {
  return a - b;
}`,
      "app.js": `const { add, subtract } = require('./math_utils.js');
console.log("Result:", add(10, 20));`,
    },
    side1Prompt:
      "File math_utils.js đang bị lỗi cú pháp module export của Node.js (dự án dùng CommonJS). Hãy kiểm tra và sửa lại math_utils.js cho đúng chuẩn CommonJS.",
    side2Prompt:
      "Hãy chạy thử lệnh `node app.js` bằng run_cmd; nếu có lỗi hãy sửa lại code và chạy lại để đảm bảo chương trình in ra kết quả thành công.",
  },
  {
    pairId: 2,
    title: "Named vs Default Export mismatch",
    files: {
      "logger.js": `function logMessage(msg) {
  console.log("[LOG]: " + msg);
}
module.exports = { logMessage };`,
      "index.js": `const logger = require('./logger');
logger("App started successfully");`,
    },
    side1Prompt:
      "Trong index.js đang bị lỗi cách import/require hàm từ module logger.js (TypeError: logger is not a function). Hãy sửa lại index.js cho đúng.",
    side2Prompt:
      "Hãy chạy thử lệnh `node index.js` bằng run_cmd; nếu có lỗi hãy kiểm tra nguyên nhân, sửa lại code và chạy lại kiểm tra kết quả.",
  },
  {
    pairId: 3,
    title: "Missing relative path prefix in require",
    files: {
      "helpers/formatter.js": `function formatCurrency(amount) {
  return amount.toLocaleString() + " VND";
}
module.exports = { formatCurrency };`,
      "main.js": `const { formatCurrency } = require('formatter');
console.log("Price:", formatCurrency(500000));`,
    },
    side1Prompt:
      "File main.js đang bị lỗi Cannot find module khi require file formatter.js trong thư mục helpers. Hãy sửa lại đường dẫn require trong main.js.",
    side2Prompt:
      "Hãy chạy thử lệnh `node main.js` bằng run_cmd; nếu gặp lỗi hãy sửa lại và chạy lại để đảm bảo in ra giá tiền thành công.",
  },
  {
    pairId: 4,
    title: "Typo in exported object keys",
    files: {
      "auth.js": `function verifyToken(token) {
  return token === "secret_token_123";
}
function generateToken(user) {
  return "token_" + user;
}
module.exports = { verifyTokens, generateToken };`,
      "server.js": `const { verifyToken } = require('./auth');
console.log("Auth Status:", verifyToken("secret_token_123"));`,
    },
    side1Prompt:
      "File auth.js đang bị lỗi typo ở phần module.exports khiến bên ngoài không gọi được verifyToken. Hãy kiểm tra và sửa lại auth.js.",
    side2Prompt:
      "Hãy chạy thử `node server.js` bằng run_cmd; nếu có lỗi hãy tìm nguyên nhân, sửa lại và chạy lại đến khi in ra Auth Status thành công.",
  },
  {
    pairId: 5,
    title: "ESM export default in CJS environment",
    files: {
      "db_config.js": `const config = {
  host: "127.0.0.1",
  port: 5432,
  database: "users_db"
};
export default config;`,
      "db.js": `const config = require('./db_config');
console.log("Database connected on port:", config.port);`,
    },
    side1Prompt:
      "File db_config.js đang dùng cú pháp 'export default' không tương thích với CommonJS require trong db.js. Hãy sửa lại db_config.js.",
    side2Prompt:
      "Hãy chạy thử `node db.js` bằng run_cmd; nếu có lỗi hãy sửa lại code và chạy lại để in ra cổng Database connected thành công.",
  },
];

interface CaseResult {
  id: string;
  side: "SIDE_1_MODULE_DIRECT" | "SIDE_2_EMERGENT_DEBUG";
  pairId: number;
  title: string;
  turns: number;
  usedReplace: boolean;
  usedWrite: boolean;
  usedReadAfterWrite: boolean;
  usedRunCmd: boolean;
  actions: string[];
  finalSuccess: boolean;
}

async function runTestCase(
  id: string,
  side: "SIDE_1_MODULE_DIRECT" | "SIDE_2_EMERGENT_DEBUG",
  pair: ModulePair,
  userPrompt: string,
  baseDir: string,
): Promise<CaseResult> {
  const cwd = path.resolve(baseDir, id.toLowerCase());
  await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true });

  for (const [relPath, content] of Object.entries(pair.files)) {
    const fullPath = path.resolve(cwd, relPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }

  const result: CaseResult = {
    id,
    side,
    pairId: pair.pairId,
    title: pair.title,
    turns: 0,
    usedReplace: false,
    usedWrite: false,
    usedReadAfterWrite: false,
    usedRunCmd: false,
    actions: [],
    finalSuccess: false,
  };

  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  let turn = 0;
  const maxTurns = 6;
  let hasWritten = false;

  console.log(`\n▶ [${id}] (${side}) - Pair ${pair.pairId}: ${pair.title}`);

  while (turn < maxTurns) {
    turn++;
    result.turns = turn;

    const payload = {
      model: "qwen3.5-4b",
      stream: false,
      temperature: 0,
      repeat_penalty: 1.0,
      reasoning_control: true,
      chat_template_kwargs: { enable_thinking: true },
      thinking_budget_tokens: 384,
      max_tokens: 1200,
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
      console.error(`   ❌ Fetch error: ${err.message}`);
      break;
    }

    if (!response.ok) {
      console.error(`   ❌ HTTP ${response.status}`);
      break;
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) break;

    const msg = choice.message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      result.finalSuccess = true;
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
          actionDesc = "REPLACE";
          result.usedReplace = true;
        } else if (fnArgs.search_text === undefined && fnArgs.replacement !== undefined) {
          actionDesc = "WRITE_ALL";
          result.usedWrite = true;
          hasWritten = true;
        } else if (fnArgs.search_text === undefined && fnArgs.replacement === undefined) {
          actionDesc = "READ_ALL";
          if (hasWritten) {
            result.usedReadAfterWrite = true;
          }
        } else if (fnArgs.search_text !== undefined && fnArgs.replacement === undefined) {
          actionDesc = "SEARCH";
        }
      } else if (fnName === "run_cmd") {
        actionDesc = `RUN_CMD("${fnArgs.command}")`;
        result.usedRunCmd = true;
      } else {
        actionDesc = fnName;
      }

      result.actions.push(actionDesc);
      process.stdout.write(`   ↳ Turn ${turn}: [${actionDesc}]`);

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
      console.log("");

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: fnName,
        content: toolResult,
      });
    }
  }

  return result;
}

async function main() {
  const rootDir = process.cwd();
  const baseSandboxDir = path.resolve(rootDir, "experiences", "module_sandbox");
  await mkdir(baseSandboxDir, { recursive: true });

  const results: CaseResult[] = [];

  console.log("================================================================");
  console.log(`🔥 BẮT ĐẦU BENCHMARK 5 CẶP CASE (10 RUNS) VỀ NODEJS MODULE ERROR`);
  console.log(`   Side 1: Báo lỗi module trực tiếp (Notification)`);
  console.log(`   Side 2: Emergent Debugging ("Chạy node... nếu có lỗi hãy sửa")`);
  console.log("================================================================");

  // Run Side 1
  for (let i = 0; i < PAIRS.length; i++) {
    const pair = PAIRS[i]!;
    const id = `S1_P${pair.pairId}`;
    console.log(`\n[Side 1 - ${i + 1}/5] Chạy case: ${id}`);
    const res = await runTestCase(id, "SIDE_1_MODULE_DIRECT", pair, pair.side1Prompt, baseSandboxDir);
    results.push(res);
  }

  // Run Side 2
  for (let i = 0; i < PAIRS.length; i++) {
    const pair = PAIRS[i]!;
    const id = `S2_P${pair.pairId}`;
    console.log(`\n[Side 2 - ${i + 1}/5] Chạy case: ${id}`);
    const res = await runTestCase(id, "SIDE_2_EMERGENT_DEBUG", pair, pair.side2Prompt, baseSandboxDir);
    results.push(res);
  }

  // Save raw results
  const resultsPath = path.resolve(rootDir, "experiences", "module-results.json");
  await writeFile(resultsPath, JSON.stringify(results, null, 2), "utf8");

  // Summary statistics
  const side1 = results.filter((r) => r.side === "SIDE_1_MODULE_DIRECT");
  const side2 = results.filter((r) => r.side === "SIDE_2_EMERGENT_DEBUG");

  const statSide1 = {
    total: side1.length,
    replaceCount: side1.filter((r) => r.usedReplace).length,
    writeCount: side1.filter((r) => r.usedWrite).length,
    readAfterWriteCount: side1.filter((r) => r.usedReadAfterWrite).length,
    avgTurns: side1.reduce((sum, r) => sum + r.turns, 0) / side1.length,
  };

  const statSide2 = {
    total: side2.length,
    replaceCount: side2.filter((r) => r.usedReplace).length,
    writeCount: side2.filter((r) => r.usedWrite).length,
    readAfterWriteCount: side2.filter((r) => r.usedReadAfterWrite).length,
    avgTurns: side2.reduce((sum, r) => sum + r.turns, 0) / side2.length,
  };

  console.log("\n================================================================");
  console.log("📊 BẢNG TỔNG HỢP SO SÁNH (5 CẶP CASE NODEJS MODULE)");
  console.log("================================================================");
  console.table({
    "Side 1 (Nêu lỗi module)": {
      "Tổng số case": statSide1.total,
      "Tỷ lệ dùng REPLACE": `${((statSide1.replaceCount / statSide1.total) * 100).toFixed(1)}% (${statSide1.replaceCount}/${statSide1.total})`,
      "Tỷ lệ dùng WRITE_ALL": `${((statSide1.writeCount / statSide1.total) * 100).toFixed(1)}% (${statSide1.writeCount}/${statSide1.total})`,
      "Tỷ lệ READ verify sau WRITE": `${((statSide1.readAfterWriteCount / statSide1.total) * 100).toFixed(1)}% (${statSide1.readAfterWriteCount}/${statSide1.total})`,
      "Số Turn trung bình": statSide1.avgTurns.toFixed(2),
    },
    "Side 2 (Emergent Debug 'Chạy thử...')" : {
      "Tổng số case": statSide2.total,
      "Tỷ lệ dùng REPLACE": `${((statSide2.replaceCount / statSide2.total) * 100).toFixed(1)}% (${statSide2.replaceCount}/${statSide2.total})`,
      "Tỷ lệ dùng WRITE_ALL": `${((statSide2.writeCount / statSide2.total) * 100).toFixed(1)}% (${statSide2.writeCount}/${statSide2.total})`,
      "Tỷ lệ READ verify sau WRITE": `${((statSide2.readAfterWriteCount / statSide2.total) * 100).toFixed(1)}% (${statSide2.readAfterWriteCount}/${statSide2.total})`,
      "Số Turn trung bình": statSide2.avgTurns.toFixed(2),
    },
  });
  console.log(`\nKết quả chi tiết được lưu tại: ${resultsPath}`);
}

main().catch(console.error);
