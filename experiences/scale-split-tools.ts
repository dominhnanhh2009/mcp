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

interface ScaleCase {
  id: string;
  title: string;
  prompt: string;
}

const SCALE_CASES: ScaleCase[] = [
  {
    id: "CASE_01",
    title: "FactorizedNumber (fact.js)",
    prompt: `hãy tạo 1 file nodejs tên "fact.js":
 - chứa 1 class FactorizedNumber:
  + được biểu diện nội bộ là 1 map/object KV, với K là các thừa số nguyên tố và V tương ứng là số mũ của thừa số đó
  + có hàm construct cho phép khởi tạo từ 1 số nguyên
  + hàm render trả về 1 string dạng "k1^v1 k_2^v_2 k3^v3 ... kn^vn"

Sau khi tạo xong fact.js, hãy tạo file "test.js" để kiểm thử FactorizedNumber rồi chạy lệnh "node test.js" bằng run_cmd để xác nhận kết quả.`,
  },
  {
    id: "CASE_02",
    title: "Stack (stack.js)",
    prompt: `Hãy tạo 1 file nodejs tên "stack.js":
 - chứa 1 class Stack (LIFO) với các method: push(val), pop(), peek(), isEmpty(), size().
 - ném lỗi nếu pop() hoặc peek() trên stack rỗng.

Sau khi tạo xong stack.js, hãy tạo file "test.js" để kiểm thử các method của Stack rồi chạy lệnh "node test.js" bằng run_cmd để xác nhận kết quả.`,
  },
  {
    id: "CASE_03",
    title: "Queue (queue.js)",
    prompt: `Hãy tạo 1 file nodejs tên "queue.js":
 - chứa 1 class Queue (FIFO) với các method: enqueue(val), dequeue(), front(), isEmpty(), size().
 - ném lỗi nếu dequeue() hoặc front() trên queue rỗng.

Sau khi tạo xong queue.js, hãy tạo file "test.js" để kiểm thử Queue rồi chạy lệnh "node test.js" bằng run_cmd để xác nhận kết quả.`,
  },
  {
    id: "CASE_04",
    title: "LRU Cache (lru.js)",
    prompt: `Hãy tạo 1 file nodejs tên "lru.js":
 - chứa class LRUCache với constructor(capacity), get(key) trả về value hoặc -1 nếu không có, put(key, value) cập nhật hoặc thêm mới và xóa item ít dùng nhất nếu quá capacity.

Sau khi tạo xong lru.js, hãy tạo file "test.js" để kiểm thử LRUCache với capacity 2 rồi chạy lệnh "node test.js" bằng run_cmd để xác nhận kết quả.`,
  },
  {
    id: "CASE_05",
    title: "String Utils (str_utils.js)",
    prompt: `Hãy tạo 1 file nodejs tên "str_utils.js":
 - export các hàm:
   + slugify(text): chuyển chuỗi có dấu/khoảng trắng thành dạng slug "hello-world"
   + camelToSnake(text): chuyển camelCase thành snake_case
   + truncate(text, maxLength): cắt chuỗi quá maxLength và thêm "..."

Sau khi tạo xong str_utils.js, hãy tạo file "test.js" để kiểm thử cả 3 hàm trên rồi chạy lệnh "node test.js" bằng run_cmd để xác nhận kết quả.`,
  },
  {
    id: "CASE_06",
    title: "Matrix 2D (matrix.js)",
    prompt: `Hãy tạo 1 file nodejs tên "matrix.js":
 - chứa class Matrix với constructor(rows, cols, initialVal=0), method set(r, c, val), get(r, c), transpose() trả về Matrix mới đã chuyển vị, and toString() in ma trận dạng lưới.

Sau khi tạo xong matrix.js, hãy tạo file "test.js" để kiểm thử ma trận 2x3 và chuyển vị của nó rồi chạy lệnh "node test.js" bằng run_cmd để xác nhận kết quả.`,
  },
  {
    id: "CASE_07",
    title: "Simple EventEmitter (events.js)",
    prompt: `Hãy tạo 1 file nodejs tên "events.js":
 - chứa class SimpleEventEmitter với các method: on(event, listener), emit(event, ...args), off(event, listener), once(event, listener).

Sau khi tạo xong events.js, hãy tạo file "test.js" để kiểm thử on, once và emit rồi chạy lệnh "node test.js" bằng run_cmd để xác nhận kết quả.`,
  },
  {
    id: "CASE_08",
    title: "Binary Search Tree (bst.js)",
    prompt: `Hãy tạo 1 file nodejs tên "bst.js":
 - chứa class BinarySearchTree với các method: insert(val), contains(val), inOrderTraversal() trả về mảng các phần tử được sắp xếp tăng dần.

Sau khi tạo xong bst.js, hãy tạo file "test.js" để chèn các số [15, 10, 20, 8, 12] và in kết quả inOrderTraversal() rồi chạy lệnh "node test.js" bằng run_cmd để xác nhận kết quả.`,
  },
  {
    id: "CASE_09",
    title: "Vector2D (vector.js)",
    prompt: `Hãy tạo 1 file nodejs tên "vector.js":
 - chứa class Vector2D với constructor(x, y), methods: add(other), subtract(other), magnitude(), dotProduct(other), toString() trả về "(x, y)".

Sau khi tạo xong vector.js, hãy tạo file "test.js" để kiểm thử cộng 2 vector và tính tích vô hướng rồi chạy lệnh "node test.js" bằng run_cmd để xác nhận kết quả.`,
  },
  {
    id: "CASE_10",
    title: "Currency Converter (currency.js)",
    prompt: `Hãy tạo 1 file nodejs tên "currency.js":
 - chứa class CurrencyConverter với methods: setRate(from, to, rate), convert(amount, from, to), getRate(from, to). Hỗ trợ suy luận tỷ giá ngược (nếu có USD->VND thì tính được VND->USD = 1/rate).

Sau khi tạo xong currency.js, hãy tạo file "test.js" để kiểm thử đổi 100 USD sang VND và ngược lại rồi chạy lệnh "node test.js" bằng run_cmd để xác nhận kết quả.`,
  },
];

interface BenchmarkResult {
  id: string;
  title: string;
  turns: number;
  createdFiles: string[];
  usedCreateCount: number;
  usedEditCount: number;
  usedReadCount: number;
  usedRunCmdCount: number;
  attemptedOverwriteWithCreate: boolean;
  actions: string[];
  finalSuccess: boolean;
}

async function runCase(
  c: ScaleCase,
  baseSandboxDir: string,
): Promise<BenchmarkResult> {
  const cwd = path.resolve(baseSandboxDir, c.id.toLowerCase());
  await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true });

  const result: BenchmarkResult = {
    id: c.id,
    title: c.title,
    turns: 0,
    createdFiles: [],
    usedCreateCount: 0,
    usedEditCount: 0,
    usedReadCount: 0,
    usedRunCmdCount: 0,
    attemptedOverwriteWithCreate: false,
    actions: [],
    finalSuccess: false,
  };

  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: c.prompt },
  ];

  let turn = 0;
  const maxTurns = 8;
  const existingFiles = new Set<string>();

  console.log(`\n================================================================`);
  console.log(`▶ [${c.id}] ${c.title}`);
  console.log(`================================================================`);

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
      console.log(`   🏁 [Turn ${turn}] Kết thúc.`);
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
        result.usedCreateCount++;
        const targetFile = fnArgs.file || "";
        if (existingFiles.has(targetFile)) {
          result.attemptedOverwriteWithCreate = true;
          actionDesc = `CREATE_FILE (OVERWRITE '${targetFile}')`;
        } else {
          existingFiles.add(targetFile);
          result.createdFiles.push(targetFile);
          actionDesc = `CREATE_FILE ('${targetFile}')`;
        }
      } else if (fnName === "edit_file") {
        result.usedEditCount++;
        actionDesc = `EDIT_FILE ('${fnArgs.file}')`;
      } else if (fnName === "read_file") {
        result.usedReadCount++;
        actionDesc = `READ_FILE ('${fnArgs.file}')`;
      } else if (fnName === "run_cmd") {
        result.usedRunCmdCount++;
        actionDesc = `RUN_CMD ("${fnArgs.command}")`;
      } else {
        actionDesc = fnName;
      }

      result.actions.push(actionDesc);
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

  return result;
}

async function main() {
  const rootDir = process.cwd();
  const baseSandboxDir = path.resolve(rootDir, "experiences", "sandbox", "scale_split_tools");
  await mkdir(baseSandboxDir, { recursive: true });

  console.log("================================================================");
  console.log(`🔥 BẮT ĐẦU BENCHMARK 10 BÀI TOÁN END-TO-END VỚI SPLIT TOOLS`);
  console.log(`   Kiến trúc: create_file, edit_file, read_file, run_cmd`);
  console.log(`   Model: qwen3.5-4b @ http://localhost:3333`);
  console.log("================================================================");

  const results: BenchmarkResult[] = [];

  for (let i = 0; i < SCALE_CASES.length; i++) {
    const c = SCALE_CASES[i]!;
    console.log(`\n[${i + 1}/10] Đang chạy: ${c.id} - ${c.title}...`);
    const res = await runCase(c, baseSandboxDir);
    results.push(res);
  }

  // Save to JSON
  const resultsPath = path.resolve(rootDir, "experiences", "split-tools-results.json");
  await writeFile(resultsPath, JSON.stringify(results, null, 2), "utf8");

  // Summary statistics
  const total = results.length;
  const totalEdits = results.reduce((sum, r) => sum + r.usedEditCount, 0);
  const casesWithEdits = results.filter((r) => r.usedEditCount > 0).length;
  const casesWithOverwrites = results.filter((r) => r.attemptedOverwriteWithCreate).length;
  const casesSuccess = results.filter((r) => r.finalSuccess).length;
  const avgTurns = results.reduce((sum, r) => sum + r.turns, 0) / total;

  console.log("\n================================================================");
  console.log("📊 BẢNG TỔNG HỢP BENCHMARK 10 BÀI TOÁN (SPLIT TOOLS ARCHITECTURE)");
  console.log("================================================================");
  console.table({
    "Tổng số case": total,
    "Tỷ lệ hoàn thành End-to-End": `${((casesSuccess / total) * 100).toFixed(1)}% (${casesSuccess}/${total})`,
    "Số case cần chỉnh sửa code": `${casesWithEdits}/${total}`,
    "Tổng số lần gọi EDIT_FILE": totalEdits,
    "Số lần ghi đè (CREATE_FILE on existing)": `${casesWithOverwrites}/${total} (${((casesWithOverwrites / total) * 100).toFixed(1)}%)`,
    "Số Turn trung bình mỗi bài": avgTurns.toFixed(2),
  });

  console.log(`\nKết quả chi tiết được lưu tại: ${resultsPath}`);
}

main().catch(console.error);
