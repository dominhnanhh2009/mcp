import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";

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

interface TestCase {
  id: string;
  group: "A_DIRECT" | "B_TASK";
  title: string;
  prompt: string;
  files: Record<string, string>;
}

interface CaseResult {
  id: string;
  group: "A_DIRECT" | "B_TASK";
  title: string;
  turns: number;
  usedReplace: boolean;
  usedWrite: boolean;
  usedReadAfterWrite: boolean;
  searchErrors: number;
  finalSuccess: boolean;
  actions: string[];
}

const CASES_GROUP_A: TestCase[] = [
  {
    id: "A1",
    group: "A_DIRECT",
    title: "Sửa port máy chủ",
    prompt: "Trong file server_config.json, hãy sửa giá trị của port từ 3000 thành 8080.",
    files: {
      "server_config.json": JSON.stringify({ host: "0.0.0.0", port: 3000, max_conn: 100 }, null, 2),
    },
  },
  {
    id: "A2",
    group: "A_DIRECT",
    title: "Sửa biến môi trường DB_HOST",
    prompt: "Trong file .env, hãy sửa DB_HOST=localhost thành DB_HOST=10.0.0.5.",
    files: {
      ".env": "PORT=5000\nDB_HOST=localhost\nDB_PORT=5432\nDB_USER=postgres\n",
    },
  },
  {
    id: "A3",
    group: "A_DIRECT",
    title: "Sửa hằng số MAX_RETRIES",
    prompt: "Trong file constants.js, hãy sửa hằng số MAX_RETRIES = 3 thành MAX_RETRIES = 5.",
    files: {
      "constants.js": "const TIMEOUT = 5000;\nconst MAX_RETRIES = 3;\nconst API_BASE = '/v1';\nmodule.exports = { TIMEOUT, MAX_RETRIES, API_BASE };\n",
    },
  },
  {
    id: "A4",
    group: "A_DIRECT",
    title: "Sửa version trong package_info.json",
    prompt: "Trong file package_info.json, hãy sửa trường version từ '1.0.0' thành '1.2.0'.",
    files: {
      "package_info.json": JSON.stringify({ name: "core-lib", version: "1.0.0", private: true }, null, 2),
    },
  },
  {
    id: "A5",
    group: "A_DIRECT",
    title: "Sửa theme giao diện",
    prompt: "Trong file theme.json, hãy đổi giá trị của currentTheme từ 'light' thành 'dark'.",
    files: {
      "theme.json": JSON.stringify({ currentTheme: "light", fontSize: 14, highContrast: false }, null, 2),
    },
  },
  {
    id: "A6",
    group: "A_DIRECT",
    title: "Sửa thời hạn token",
    prompt: "Trong file auth_config.js, hãy đổi giá trị TOKEN_EXPIRY từ '1h' thành '24h'.",
    files: {
      "auth_config.js": "const SECRET = 'xyz123';\nconst TOKEN_EXPIRY = '1h';\nconst ALGO = 'HS256';\nmodule.exports = { SECRET, TOKEN_EXPIRY, ALGO };\n",
    },
  },
  {
    id: "A7",
    group: "A_DIRECT",
    title: "Sửa đơn vị tiền tệ",
    prompt: "Trong file currency.json, hãy sửa DEFAULT_CURRENCY từ 'USD' thành 'VND'.",
    files: {
      "currency.json": JSON.stringify({ DEFAULT_CURRENCY: "USD", SUPPORTED: ["USD", "EUR", "VND"] }, null, 2),
    },
  },
  {
    id: "A8",
    group: "A_DIRECT",
    title: "Sửa default role",
    prompt: "Trong file user_roles.js, hãy đổi DEFAULT_ROLE = 'guest' thành DEFAULT_ROLE = 'member'.",
    files: {
      "user_roles.js": "const ROLES = ['admin', 'member', 'guest'];\nconst DEFAULT_ROLE = 'guest';\nmodule.exports = { ROLES, DEFAULT_ROLE };\n",
    },
  },
  {
    id: "A9",
    group: "A_DIRECT",
    title: "Sửa API base path",
    prompt: "Trong file routes.js, hãy sửa API_PATH = '/api/v1' thành API_PATH = '/api/v2'.",
    files: {
      "routes.js": "const API_PATH = '/api/v1';\nconst HEALTH_PATH = '/health';\nmodule.exports = { API_PATH, HEALTH_PATH };\n",
    },
  },
  {
    id: "A10",
    group: "A_DIRECT",
    title: "Sửa cổng SMTP",
    prompt: "Trong file email_settings.json, hãy sửa smtp_port từ 25 thành 587.",
    files: {
      "email_settings.json": JSON.stringify({ smtp_server: "mail.example.com", smtp_port: 25, use_ssl: false }, null, 2),
    },
  },
];

const CASES_GROUP_B: TestCase[] = [
  {
    id: "B1",
    group: "B_TASK",
    title: "Thêm giảm giá khách VIP",
    prompt: "Hãy đọc file discount_service.js và cập nhật logic: nếu order.customerType là 'VIP', giảm 15% tổng tiền itemsTotal trước khi trả về.",
    files: {
      "discount_service.js": `function calculateFinalPrice(order) {
  let itemsTotal = 0;
  for (const item of order.items) {
    itemsTotal += item.price * item.qty;
  }
  return itemsTotal;
}
module.exports = { calculateFinalPrice };`,
    },
  },
  {
    id: "B2",
    group: "B_TASK",
    title: "Thêm kiểm tra miễn thuế VAT",
    prompt: "Hãy kiểm tra file tax_calculator.js và cập nhật hàm computeTax: nếu item.isTaxExempt === true thì tax bằng 0, ngược lại tax = price * 0.1.",
    files: {
      "tax_calculator.js": `function computeTax(item) {
  let tax = item.price * 0.1;
  return tax;
}
module.exports = { computeTax };`,
    },
  },
  {
    id: "B3",
    group: "B_TASK",
    title: "Bổ sung validate độ dài password",
    prompt: "Hãy đọc file user_validator.js và thêm kiểm tra: nếu password.length < 8 thì throw new Error('Password must be at least 8 characters').",
    files: {
      "user_validator.js": `function validateUser(username, password) {
  if (!username) {
    throw new Error('Username is required');
  }
  return true;
}
module.exports = { validateUser };`,
    },
  },
  {
    id: "B4",
    group: "B_TASK",
    title: "Bổ sung kiểm tra tồn kho",
    prompt: "Hãy cập nhật file stock_manager.js: trong hàm deductStock, nếu stock.qty < requestedQty thì throw new Error('Out of stock'), ngược lại trừ stock.qty.",
    files: {
      "stock_manager.js": `function deductStock(stock, requestedQty) {
  stock.qty -= requestedQty;
  return stock.qty;
}
module.exports = { deductStock };`,
    },
  },
  {
    id: "B5",
    group: "B_TASK",
    title: "Thêm bonus điểm cho chuỗi thắng",
    prompt: "Hãy cập nhật file game_score.js: trong hàm calcScore, nếu player.streak >= 5 thì nhân đôi score (score * 2) trước khi trả về.",
    files: {
      "game_score.js": `function calcScore(player, basePoints) {
  let score = basePoints;
  return score;
}
module.exports = { calcScore };`,
    },
  },
  {
    id: "B6",
    group: "B_TASK",
    title: "Phân hạng giới hạn Rate Limit",
    prompt: "Hãy cập nhật file rate_limiter.js: nếu user.isPremium === true thì maxRequests là 1000, ngược lại maxRequests là 100.",
    files: {
      "rate_limiter.js": `function getLimit(user) {
  let maxRequests = 100;
  return maxRequests;
}
module.exports = { getLimit };`,
    },
  },
  {
    id: "B7",
    group: "B_TASK",
    title: "Tính phí giao hàng Express",
    prompt: "Hãy cập nhật file shipping_fee.js: nếu option.isExpress === true thì nhân đôi fee (fee = fee * 2) và cộng thêm 15000 phí bảo hiểm.",
    files: {
      "shipping_fee.js": `function getShippingFee(distanceKm, option) {
  let fee = distanceKm * 5000;
  return fee;
}
module.exports = { getShippingFee };`,
    },
  },
  {
    id: "B8",
    group: "B_TASK",
    title: "Thêm kiểm tra trạng thái hoạt động",
    prompt: "Hãy cập nhật file filter_users.js: trong hàm getActiveUsers, chỉ giữ lại user có user.status === 'active' VÀ user.verified === true.",
    files: {
      "filter_users.js": `function getActiveUsers(users) {
  return users.filter(user => user.status === 'active');
}
module.exports = { getActiveUsers };`,
    },
  },
  {
    id: "B9",
    group: "B_TASK",
    title: "Xử lý xóa key hết hạn cache",
    prompt: "Hãy cập nhật file simple_cache.js: trong hàm get(key), nếu Date.now() > item.expiry thì xóa item khỏi cache và trả về null.",
    files: {
      "simple_cache.js": `const store = new Map();
function get(key) {
  const item = store.get(key);
  if (!item) return null;
  return item.value;
}
module.exports = { get, store };`,
    },
  },
  {
    id: "B10",
    group: "B_TASK",
    title: "Thêm phí đóng gói đặc biệt",
    prompt: "Hãy cập nhật file package_fee.js: trong hàm calculatePackaging, nếu packageInfo.isFragile === true thì cộng thêm 20000 phí chống sốc.",
    files: {
      "package_fee.js": `function calculatePackaging(packageInfo) {
  let cost = 10000;
  return cost;
}
module.exports = { calculatePackaging };`,
    },
  },
];

async function runSingleCase(testCase: TestCase, baseSandboxDir: string): Promise<CaseResult> {
  const cwd = path.resolve(baseSandboxDir, testCase.id.toLowerCase());
  await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true });

  for (const [relPath, content] of Object.entries(testCase.files)) {
    const fullPath = path.resolve(cwd, relPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }

  const result: CaseResult = {
    id: testCase.id,
    group: testCase.group,
    title: testCase.title,
    turns: 0,
    usedReplace: false,
    usedWrite: false,
    usedReadAfterWrite: false,
    searchErrors: 0,
    finalSuccess: false,
    actions: [],
  };

  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: testCase.prompt },
  ];

  let turn = 0;
  const maxTurns = 5;
  let hasWritten = false;

  console.log(`\n▶ [${testCase.id}] (${testCase.group}) ${testCase.title}`);

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
      } else {
        actionDesc = fnName;
      }

      result.actions.push(actionDesc);
      process.stdout.write(`   ↳ Turn ${turn}: [${actionDesc}]`);

      let toolResult = "";
      try {
        if (fnName === "text_editor") {
          toolResult = await executeTextEditor(cwd, fnArgs);
          if (toolResult.includes("below the required 90%") || toolResult.includes("matches tied")) {
            result.searchErrors++;
            process.stdout.write(` (⚠️ Match Error)`);
          }
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
  const baseSandboxDir = path.resolve(rootDir, "experiences", "scale_sandbox");
  await mkdir(baseSandboxDir, { recursive: true });

  const allCases = [...CASES_GROUP_A, ...CASES_GROUP_B];
  const results: CaseResult[] = [];

  console.log("================================================================");
  console.log(`🔥 BẮT ĐẦU BENCHMARK 20 TEST CASES TRÊN QWEN3.5-4B`);
  console.log(`   Group A: 10 bài toán sửa trực tiếp (Direct/Focused Edit)`);
  console.log(`   Group B: 10 bài toán nghiệp vụ (Task-Oriented Code Edit)`);
  console.log("================================================================");

  for (let i = 0; i < allCases.length; i++) {
    const tc = allCases[i]!;
    console.log(`\n[${i + 1}/${allCases.length}] Tiến hành chạy case: ${tc.id}`);
    const res = await runSingleCase(tc, baseSandboxDir);
    results.push(res);
  }

  // Save raw results
  const resultsPath = path.resolve(rootDir, "experiences", "scale-results.json");
  await writeFile(resultsPath, JSON.stringify(results, null, 2), "utf8");

  // Summary statistics
  const groupA = results.filter((r) => r.group === "A_DIRECT");
  const groupB = results.filter((r) => r.group === "B_TASK");

  const statGroupA = {
    total: groupA.length,
    replaceCount: groupA.filter((r) => r.usedReplace).length,
    writeCount: groupA.filter((r) => r.usedWrite).length,
    readAfterWriteCount: groupA.filter((r) => r.usedReadAfterWrite).length,
    avgTurns: groupA.reduce((sum, r) => sum + r.turns, 0) / groupA.length,
  };

  const statGroupB = {
    total: groupB.length,
    replaceCount: groupB.filter((r) => r.usedReplace).length,
    writeCount: groupB.filter((r) => r.usedWrite).length,
    readAfterWriteCount: groupB.filter((r) => r.usedReadAfterWrite).length,
    avgTurns: groupB.reduce((sum, r) => sum + r.turns, 0) / groupB.length,
  };

  console.log("\n================================================================");
  console.log("📊 BẢNG TỔNG HỢP THỐNG KÊ (LUẬT SỐ LỚN)");
  console.log("================================================================");
  console.table({
    "Group A (Direct/Dễ)": {
      "Tổng số case": statGroupA.total,
      "Tỷ lệ dùng REPLACE": `${((statGroupA.replaceCount / statGroupA.total) * 100).toFixed(1)}% (${statGroupA.replaceCount}/${statGroupA.total})`,
      "Tỷ lệ dùng WRITE_ALL": `${((statGroupA.writeCount / statGroupA.total) * 100).toFixed(1)}% (${statGroupA.writeCount}/${statGroupA.total})`,
      "Tỷ lệ READ verify sau WRITE": `${((statGroupA.readAfterWriteCount / statGroupA.total) * 100).toFixed(1)}% (${statGroupA.readAfterWriteCount}/${statGroupA.total})`,
      "Số Turn trung bình": statGroupA.avgTurns.toFixed(2),
    },
    "Group B (Task-Oriented)": {
      "Tổng số case": statGroupB.total,
      "Tỷ lệ dùng REPLACE": `${((statGroupB.replaceCount / statGroupB.total) * 100).toFixed(1)}% (${statGroupB.replaceCount}/${statGroupB.total})`,
      "Tỷ lệ dùng WRITE_ALL": `${((statGroupB.writeCount / statGroupB.total) * 100).toFixed(1)}% (${statGroupB.writeCount}/${statGroupB.total})`,
      "Tỷ lệ READ verify sau WRITE": `${((statGroupB.readAfterWriteCount / statGroupB.total) * 100).toFixed(1)}% (${statGroupB.readAfterWriteCount}/${statGroupB.total})`,
      "Số Turn trung bình": statGroupB.avgTurns.toFixed(2),
    },
  });
  console.log(`\nKết quả chi tiết được lưu tại: ${resultsPath}`);
}

main().catch(console.error);
