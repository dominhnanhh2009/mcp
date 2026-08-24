import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import vm from "node:vm";

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

// FULL ECOSYSTEM OF TOOLS:
// 1. create_file
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

// 2. edit_file
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

// 3. read_file
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

// 5. js_calculator
function executeJsCalculator(expression: string) {
  try {
    const source = expression.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
    const value = vm.runInNewContext(source, Object.create(null), { timeout: 5000 });
    return JSON.stringify({ result: value });
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

// 6. get_current_time
function executeGetCurrentTime(timezone?: string) {
  const now = new Date();
  return JSON.stringify({ time: now.toISOString(), timezone: timezone || "UTC" });
}

// 7. image_viewer
function executeImageViewer(file: string) {
  return JSON.stringify({ error: "Image viewing not applicable in text mode" });
}

// FULL ECOSYSTEM TOOL SCHEMAS:
const FULL_SPLIT_TOOLS_SCHEMA = [
  {
    type: "function",
    function: {
      name: "create_file",
      description:
        "Create a new UTF-8 file with the given content. Use this tool ONLY when creating a new file.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Target file path to create" },
          content: { type: "string", description: "The full initial text content for the new file" },
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
          file: { type: "string", description: "Target file path to edit" },
          search_text: { type: "string", description: "Exact existing code snippet in the file to replace" },
          replacement: { type: "string", description: "New code snippet to replace search_text with" },
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
          file: { type: "string", description: "Target file path to read" },
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
        "Run an unsandboxed command with Windows cmd.exe. NEVER use this tool when another provided tool can perform the operation. Use it only when all other tools are unsuitable. NEVER use shell file-reading or file-writing commands such as `cat file`, `echo text > file`, `echo text >> file`, or the `>>` redirection operator; use `read_file`, `create_file`, or `edit_file` instead.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout_ms: { default: 30000, description: "Maximum run time in milliseconds", type: "integer" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "js_calculator",
      description:
        "Evaluate JavaScript without Node.js APIs. Put the answer in the final expression, for example `\"hello\".toUpperCase()`. To return multiple values at once, combine them into an object (recommended), an array, or a string; for example `({ sum: 2 + 3, product: 2 * 3 })`. NEVER use console.log or top-level return.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "JavaScript source whose final expression is the answer" },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current time in an optional IANA timezone.",
      parameters: {
        type: "object",
        properties: {
          timezone: { type: "string", description: "IANA timezone, for example Asia/Bangkok or UTC" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "image_viewer",
      description: "View an image file.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Image path" },
        },
        required: ["file"],
      },
    },
  },
];

const SYSTEM_PROMPT =
  "Paths are relative to the server workspace unless absolute. " +
  "Use `create_file` to create new files, `edit_file` to modify existing files with targeted changes, and `read_file` to read files. Use `run_cmd` ONLY when no other tool can perform the operation. " +
  "For existing files, ALWAYS prefer `edit_file` to make targeted edits and preserve unrelated structure. " +
  "Tool failures are returned as error results.";

interface TestCase {
  id: string;
  title: string;
  initialFiles: Record<string, string>;
  prompt: string;
}

const TEST_CASES: TestCase[] = [
  {
    id: "FULL_01",
    title: "FactorizedNumber (fact.js + test.js)",
    initialFiles: {},
    prompt: `hãy tạo 1 file nodejs tên "fact.js":
 - chứa 1 class FactorizedNumber:
  + được biểu diện nội bộ là 1 map/object KV, với K là các thừa số nguyên tố và V tương ứng là số mũ của thừa số đó
  + có hàm construct cho phép khởi tạo từ 1 số nguyên
  + hàm render trả về 1 string dạng "k1^v1 k_2^v_2 k3^v3 ... kn^vn"

Sau khi tạo xong fact.js, hãy tạo file "test.js" để kiểm thử FactorizedNumber rồi chạy lệnh "node test.js" bằng run_cmd để xác nhận kết quả.`,
  },
  {
    id: "FULL_02",
    title: "Math CJS to ESM (Existing 120-line file)",
    initialFiles: {
      "package.json": JSON.stringify({ type: "module" }, null, 2),
      "math.js": `// Math Utility Library
export function add(a, b) { return a + b; }
export function sub(a, b) { return a - b; }
export function mul(a, b) { return a * b; }
export function div(a, b) { return a / b; }
export function mod(a, b) { return a % b; }
export function pow(a, b) { return Math.pow(a, b); }
export function sqrt(a) { return Math.sqrt(a); }
export function abs(a) { return Math.abs(a); }
export function ceil(a) { return Math.ceil(a); }
export function floor(a) { return Math.floor(a); }
export function round(a) { return Math.round(a); }
export function max(a, b) { return Math.max(a, b); }
export function min(a, b) { return Math.min(a, b); }
export function clamp(val, low, high) { return Math.min(Math.max(val, low), high); }

// Old export error at end:
module.exports = { add, sub, mul, div, mod, pow, sqrt, abs, ceil, floor, round, max, min, clamp };
`,
      "index.js": `import { add, mul, clamp } from './math.js';
console.log('add(2, 3) =', add(2, 3));
console.log('mul(4, 5) =', mul(4, 5));
console.log('clamp(15, 0, 10) =', clamp(15, 0, 10));
`,
    },
    prompt: `Hãy chạy thử "node index.js" bằng run_cmd; nếu có lỗi hãy sửa file liên quan để chạy thành công.`,
  },
  {
    id: "FULL_03",
    title: "Server Export Syntax (Existing 80-line file)",
    initialFiles: {
      "package.json": JSON.stringify({ type: "module" }, null, 2),
      "server.js": `// HTTP Configuration Server
export const PORT = 8080;
export const HOST = "127.0.0.1";
export const TIMEOUT = 5000;
export const MAX_CONNECTIONS = 100;
export const SSL_ENABLED = false;

export function getServerConfig() {
  return { port: PORT, host: HOST, timeout: TIMEOUT };
}

export function logServerStart() {
  console.log(\`Server running at http://\${HOST}:\${PORT}\`);
}

// Erroneous export:
export default { PORT, HOST, TIMEOUT, getServerConfig, logServerStart };
`,
      "app.js": `import config from './server.js';
console.log('Port:', config.PORT);
config.logServerStart();
`,
    },
    prompt: `Hãy chạy thử "node app.js" bằng run_cmd; nếu có lỗi hãy sửa file server.js để app.js chạy thành công.`,
  },
  {
    id: "FULL_04",
    title: "Config CJS Require (Existing file)",
    initialFiles: {
      "package.json": JSON.stringify({ type: "module" }, null, 2),
      "config.js": `// App Configuration
const path = require('node:path');
const fs = require('node:fs');

export const APP_NAME = "MyApp";
export const VERSION = "1.0.0";
export function getAppPath() {
  return path.resolve('.');
}
`,
      "main.js": `import { APP_NAME, VERSION, getAppPath } from './config.js';
console.log(APP_NAME, VERSION, getAppPath());
`,
    },
    prompt: `Hãy chạy thử "node main.js" bằng run_cmd; nếu có lỗi hãy sửa để main.js chạy thành công.`,
  },
  {
    id: "FULL_05",
    title: "Auth JWT Import (Existing file)",
    initialFiles: {
      "package.json": JSON.stringify({ type: "module" }, null, 2),
      "auth.js": `// Authentication Module
export function createToken(username) {
  return "TOKEN_" + Buffer.from(username).toString('base64');
}

export function verifyToken(token) {
  if (!token.startsWith("TOKEN_")) return null;
  return Buffer.from(token.slice(6), 'base64').toString('utf8');
}

// Wrong export format
exports.createToken = createToken;
exports.verifyToken = verifyToken;
`,
      "auth_test.js": `import { createToken, verifyToken } from './auth.js';
const token = createToken("alice");
console.log("Token:", token);
console.log("Verified:", verifyToken(token));
`,
    },
    prompt: `Hãy chạy thử "node auth_test.js" bằng run_cmd; nếu có lỗi hãy sửa file auth.js để kiểm thử thành công.`,
  },
];

async function runTestCase(tc: TestCase, baseSandboxDir: string) {
  const cwd = path.resolve(baseSandboxDir, tc.id.toLowerCase());
  await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true });

  const existingFiles = new Set<string>();
  for (const [relPath, content] of Object.entries(tc.initialFiles)) {
    const fullPath = path.resolve(cwd, relPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    existingFiles.add(relPath);
  }

  console.log(`\n================================================================`);
  console.log(`▶ [${tc.id}] ${tc.title}`);
  console.log(`  (Initial existing files: ${[...existingFiles].join(", ") || "None"})`);
  console.log(`================================================================`);

  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: tc.prompt },
  ];

  let turn = 0;
  const maxTurns = 8;
  const actions: string[] = [];
  let attemptedOverwriteWithCreate = false;
  let usedEditCount = 0;
  let usedCreateCount = 0;

  while (turn < maxTurns) {
    turn++;

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
      tools: FULL_SPLIT_TOOLS_SCHEMA,
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
      console.log(`   🏁 [Turn ${turn}] Model kết thúc hội thoại.`);
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
      if (fnName === "create_file") {
        usedCreateCount++;
        const targetFile = fnArgs.file || "";
        if (existingFiles.has(targetFile)) {
          attemptedOverwriteWithCreate = true;
          actionDesc = `CREATE_FILE (OVERWRITE '${targetFile}') 🚨`;
        } else {
          existingFiles.add(targetFile);
          actionDesc = `CREATE_FILE ('${targetFile}')`;
        }
      } else if (fnName === "edit_file") {
        usedEditCount++;
        actionDesc = `EDIT_FILE ('${fnArgs.file}') 🎯`;
      } else if (fnName === "read_file") {
        actionDesc = `READ_FILE ('${fnArgs.file}')`;
      } else if (fnName === "run_cmd") {
        actionDesc = `RUN_CMD ("${fnArgs.command}")`;
      } else if (fnName === "js_calculator") {
        actionDesc = `JS_CALCULATOR ("${fnArgs.expression}")`;
      } else if (fnName === "get_current_time") {
        actionDesc = `GET_CURRENT_TIME`;
      } else if (fnName === "image_viewer") {
        actionDesc = `IMAGE_VIEWER ('${fnArgs.file}')`;
      }

      actions.push(actionDesc);
      console.log(`   ↳ Turn ${turn}: [${actionDesc}]`);

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
        } else if (fnName === "js_calculator") {
          toolResult = executeJsCalculator(fnArgs.expression);
        } else if (fnName === "get_current_time") {
          toolResult = executeGetCurrentTime(fnArgs.timezone);
        } else if (fnName === "image_viewer") {
          toolResult = executeImageViewer(fnArgs.file);
        } else {
          toolResult = JSON.stringify({ error: `Tool ${fnName} not recognized` });
        }
      } catch (err: any) {
        toolResult = JSON.stringify({ error: err.message });
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: fnName,
        content: toolResult,
      });
    }
  }

  return {
    id: tc.id,
    title: tc.title,
    turns: turn,
    usedCreateCount,
    usedEditCount,
    attemptedOverwriteWithCreate,
    actions,
  };
}

async function main() {
  const rootDir = process.cwd();
  const baseSandboxDir = path.resolve(rootDir, "experiences", "sandbox", "test_full_schema_split");
  await mkdir(baseSandboxDir, { recursive: true });

  console.log("================================================================");
  console.log("🔥 TEST TRỌN BỘ 7 TOOL (GIỮ NGUYÊN CÁC TOOL KHÁC + SPLIT FILESYSTEM)");
  console.log("   Tools: create_file, edit_file, read_file, run_cmd, js_calculator, get_current_time, image_viewer");
  console.log("================================================================");

  const results: any[] = [];
  for (let i = 0; i < TEST_CASES.length; i++) {
    const res = await runTestCase(TEST_CASES[i]!, baseSandboxDir);
    results.push(res);
  }

  const resultsPath = path.resolve(rootDir, "experiences", "full-schema-results.json");
  await writeFile(resultsPath, JSON.stringify(results, null, 2), "utf8");

  console.log("\n================================================================");
  console.log("📊 BẢNG TỔNG HỢP (FULL 7 TOOLS ECOSYSTEM)");
  console.log("================================================================");
  console.table(results.map((r) => ({
    "Case ID": r.id,
    "Tiêu đề": r.title,
    "Turns": r.turns,
    "Số lần EDIT_FILE": r.usedEditCount,
    "Ghi đè file cũ (CREATE_FILE)": r.attemptedOverwriteWithCreate ? "🚨 CÓ" : "✅ KHÔNG (0)",
  })));
}

main().catch(console.error);
