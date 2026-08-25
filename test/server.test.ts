import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import { parseConfig } from "../src/config.js";
import { startServer } from "../src/server.js";

let workspace: string;
let server: Server;
let client: Client;
let baseUrl: string;

function firstText(result: unknown): string {
  const content = (result as {
    content?: Array<{ type: string; text?: string }>;
  }).content;
  const first = content?.[0];
  assert.equal(first?.type, "text");
  return first.text ?? "";
}

before(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "minimal-mcp-"));
  server = await startServer({ port: 0, cwd: workspace });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;

  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
    ),
  );
});

after(async () => {
  await client.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(workspace, { recursive: true, force: true });
});

test("uses a server-start timestamp as the default workspace name", () => {
  const config = parseConfig([]);
  assert.equal(path.dirname(path.dirname(config.cwd)), process.cwd());
  assert.equal(path.basename(path.dirname(config.cwd)), "sandbox");
  assert.match(path.basename(config.cwd), /^\d{6}-\d{6}$/);
});

test("reads the optional llama-server URL", () => {
  assert.equal(
    parseConfig(["--llama-server-url", "http://127.0.0.1:3333"]).llamaServerUrl,
    "http://127.0.0.1:3333",
  );
  assert.equal(parseConfig([]).llamaServerUrl, undefined);
});

test("allows browser requests from every origin", async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:8080",
      "access-control-request-method": "POST",
      "access-control-request-headers":
        "content-type,mcp-protocol-version,last-event-id",
      "access-control-request-private-network": "true",
    },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(
    response.headers.get("access-control-allow-methods"),
    "GET, POST, DELETE, OPTIONS",
  );
  assert.equal(
    response.headers.get("access-control-allow-headers"),
    "content-type,mcp-protocol-version,last-event-id",
  );
  assert.equal(
    response.headers.get("access-control-allow-private-network"),
    "true",
  );
});

test("lists all built-in tools", async () => {
  assert.equal(
    client.getInstructions(),
    "Paths are relative to the server workspace unless absolute. " +
      "Use `create_file` to create new files, `edit_file` to modify existing files with targeted changes, and `read_file` to read files. Use `run_cmd` ONLY when no other tool can perform the operation. " +
      "For existing files, ALWAYS prefer `edit_file` to make targeted edits and preserve unrelated structure. " +
      "After an edit, verify with the returned review; NEVER reread the whole file just to verify it. " +
      "Tool failures are returned as MCP error results.",
  );

  const result = await client.listTools();
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    [
      "read_file",
      "create_file",
      "edit_file",
      "image_viewer",
      "run_cmd",
      "js_calculator",
      "get_current_time",
    ],
  );
  assert.match(
    result.tools.find((tool) => tool.name === "run_cmd")?.description ?? "",
    /NEVER use this tool when another provided tool.*only when all other tools are unsuitable.*Use it for shell-only operations/,
  );
  const runCmdDescription =
    result.tools.find((tool) => tool.name === "run_cmd")?.description ?? "";
  assert.match(
    runCmdDescription,
    process.platform === "win32"
      ? /Windows cmd\.exe.*listing \(`dir`\).*renaming \(`move a b`\)/i
      : /\/bin\/sh.*listing \(`ls`\).*renaming \(`mv a b`\)/,
  );
  assert.match(
    runCmdDescription,
    /NEVER use shell file-reading or file-writing commands.*`cat file`.*`echo text > file`.*`echo text >> file`.*`>>` redirection operator.*use `read_file`, `create_file`, or `edit_file`/,
  );
  assert.match(
    result.tools.find((tool) => tool.name === "read_file")?.description ?? "",
    /Read or search the UTF-8 text content of a file/,
  );
  assert.match(
    result.tools.find((tool) => tool.name === "create_file")?.description ?? "",
    /Create a new UTF-8 file with the given content/,
  );
  assert.match(
    result.tools.find((tool) => tool.name === "edit_file")?.description ?? "",
    /Edit an existing file by replacing a specific target snippet with new text/,
  );
  const readFileSchema = result.tools.find(
    (tool) => tool.name === "read_file",
  )?.inputSchema as {
    required?: string[];
    $schema?: string;
  };
  assert.deepEqual(readFileSchema.required, ["file"]);
  assert.equal(readFileSchema.$schema, undefined);

  const createFileSchema = result.tools.find(
    (tool) => tool.name === "create_file",
  )?.inputSchema as {
    required?: string[];
    $schema?: string;
  };
  assert.deepEqual(createFileSchema.required, ["file"]);
  assert.equal(createFileSchema.$schema, undefined);

  const editFileSchema = result.tools.find(
    (tool) => tool.name === "edit_file",
  )?.inputSchema as {
    required?: string[];
    $schema?: string;
  };
  assert.deepEqual(editFileSchema.required, ["file", "search_text", "replacement"]);
  assert.equal(editFileSchema.$schema, undefined);

  assert.match(
    result.tools.find((tool) => tool.name === "js_calculator")?.description ?? "",
    /final expression/,
  );
  assert.match(
    result.tools.find((tool) => tool.name === "js_calculator")?.description ?? "",
    /NEVER use console\.log/,
  );
  assert.match(
    result.tools.find((tool) => tool.name === "js_calculator")?.description ?? "",
    /object \(recommended\), an array, or a string/,
  );
});

test("returns base64 image content directly", async () => {
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  await writeFile(path.join(workspace, "sample.png"), image);

  const result = await client.callTool({
    name: "image_viewer",
    arguments: { file: "sample.png" },
  });

  assert.deepEqual(result.content, [
    {
      type: "image",
      data: image.toString("base64"),
      mimeType: "image/png",
    },
  ]);
});

test("creates and reads a whole file through create_file and read_file", async () => {
  const write = await client.callTool({
    name: "create_file",
    arguments: { file: "notes/hello.txt", content: "xin chào" },
  });
  const result = await client.callTool({
    name: "read_file",
    arguments: { file: "notes/hello.txt" },
  });

  assert.equal(await readFile(path.join(workspace, "notes/hello.txt"), "utf8"), "xin chào");
  assert.match(firstText(write), /Created file \(9 bytes written\)/);
  assert.equal(firstText(write).includes("notes/hello.txt"), false);
  assert.equal(firstText(write).includes("xin chào"), false);
  assert.equal(firstText(result), "xin chào");
});

test("normalizes typographic quotes when writing JavaScript and TypeScript", async () => {
  const javascript = "const greeting = \u201chello\u201d; greeting";
  const typescript = "const greeting: string = \u2018hello\u2019; greeting";

  await client.callTool({
    name: "create_file",
    arguments: { file: "src/greeting.js", content: javascript },
  });
  await client.callTool({
    name: "create_file",
    arguments: { file: "src/greeting.ts", content: typescript },
  });

  assert.equal(
    await readFile(path.join(workspace, "src/greeting.js"), "utf8"),
    'const greeting = "hello"; greeting',
  );
  assert.equal(
    await readFile(path.join(workspace, "src/greeting.ts"), "utf8"),
    "const greeting: string = 'hello'; greeting",
  );
});

test("preserves typographic quotes in non-code files", async () => {
  const content = "Keep \u201ctypographic quotes\u201d here.";

  await client.callTool({
    name: "create_file",
    arguments: { file: "notes/quotes.txt", content: content },
  });

  assert.equal(
    await readFile(path.join(workspace, "notes/quotes.txt"), "utf8"),
    content,
  );
});

test("finds case-insensitively and replaces one closest match", async () => {
  await client.callTool({
    name: "create_file",
    arguments: {
      file: "notes/search.txt",
      content: "before The quick brown fox after",
    },
  });

  const result = await client.callTool({
    name: "edit_file",
    arguments: {
      file: "notes/search.txt",
      search_text: "the quick brown fix",
      replacement: "the slow fox",
    },
  });

  assert.equal(
    await readFile(path.join(workspace, "notes/search.txt"), "utf8"),
    "before the slow fox after",
  );
  const text = firstText(result);
  assert.match(text, /Updated file \([\d.]+% match\)/);
  assert.match(text, /the slow fox/);
});

test("edit_file does not edit ambiguous or low-confidence matches", async () => {
  const ambiguous = "repeat me / repeat me";
  await client.callTool({
    name: "create_file",
    arguments: { file: "notes/ambiguous.txt", content: ambiguous },
  });
  const tied = await client.callTool({
    name: "edit_file",
    arguments: {
      file: "notes/ambiguous.txt",
      search_text: "repeat me",
      replacement: "changed",
    },
  });
  assert.equal((tied as { isError?: boolean }).isError, true);
  assert.match(firstText(tied), /Found 2 matches/);
  assert.equal(firstText(tied).includes("filesystem.ts"), false);
  assert.equal(firstText(tied).includes("at async"), false);
  assert.equal(
    await readFile(path.join(workspace, "notes/ambiguous.txt"), "utf8"),
    ambiguous,
  );

  const low = await client.callTool({
    name: "edit_file",
    arguments: {
      file: "notes/ambiguous.txt",
      search_text: "completely unrelated content",
      replacement: "changed",
    },
  });
  assert.equal((low as { isError?: boolean }).isError, true);
  assert.match(firstText(low), /below the required 90%/);
  assert.equal(firstText(low).includes("filesystem.ts"), false);
  assert.equal(firstText(low).includes("at async"), false);
  assert.equal(
    await readFile(path.join(workspace, "notes/ambiguous.txt"), "utf8"),
    ambiguous,
  );
});

test("search mode does not duplicate overlapping matches for a single occurrence", async () => {
  await client.callTool({
    name: "create_file",
    arguments: {
      file: "notes/single-match.txt",
      content: "some prefix longuniquepattern some suffix",
    },
  });

  const result = await client.callTool({
    name: "read_file",
    arguments: {
      file: "notes/single-match.txt",
      search_text: "longuniquepattern",
    },
  });
  const text = firstText(result);
  assert.match(text, /\[Match 1 - 100%\]/);
  assert.match(text, /longuniquepattern/);
});

test("search mode returns up to three high-confidence matches", async () => {
  await client.callTool({
    name: "create_file",
    arguments: {
      file: "notes/matches.txt",
      content: "alpha target / target / target / target",
    },
  });

  const result = await client.callTool({
    name: "read_file",
    arguments: { file: "notes/matches.txt", search_text: "target" },
  });
  const text = firstText(result);
  assert.match(text, /\[Match 1 -/);
  assert.match(text, /\[Match 2 -/);
  assert.match(text, /\[Match 3 -/);
  assert.equal(text.includes("[Match 4 -"), false);
});

test("treats WHOLE_FILE as ordinary searchable text", async () => {
  await client.callTool({
    name: "create_file",
    arguments: {
      file: "notes/literal-sentinel.txt",
      content: "before WHOLE_FILE after",
    },
  });

  const result = await client.callTool({
    name: "read_file",
    arguments: {
      file: "notes/literal-sentinel.txt",
      search_text: "WHOLE_FILE",
    },
  });
  const text = firstText(result);
  assert.match(text, /\[Match 1 - 100%\]/);
  assert.match(text, /WHOLE_FILE/);
});

test("edit_file normalizes typographic quotes only for JavaScript files", async () => {
  await client.callTool({
    name: "create_file",
    arguments: { file: "edit.js", content: "const value = 'old';" },
  });
  await client.callTool({
    name: "edit_file",
    arguments: {
      file: "edit.js",
      search_text: "'old'",
      replacement: "“new”",
    },
  });
  assert.equal(
    await readFile(path.join(workspace, "edit.js"), "utf8"),
    'const value = "new";',
  );
});

test("does not echo input paths in filesystem errors", async () => {
  const missingPath = "private/missing-secret-name.txt";
  const result = await client.callTool({
    name: "read_file",
    arguments: { file: missingPath },
  });

  assert.equal((result as { isError?: boolean }).isError, true);
  assert.equal(firstText(result), "File or directory does not exist (ENOENT)");
  assert.equal(firstText(result).includes(missingPath), false);
});

test("runs JavaScript calculations without repeating the input", async () => {
  const expression = "const base = Math.pow(2, 10); base + Math.log(Math.E)";
  const result = await client.callTool({
    name: "js_calculator",
    arguments: { expression },
  });
  const text = firstText(result);
  assert.equal(text, "1025");
  assert.equal(text.includes(expression), false);
});

test("normalizes typographic quotes in JavaScript", async () => {
  const result = await client.callTool({
    name: "js_calculator",
    arguments: {
      expression:
        "const left = ‘hello’; const right = “world”; [left, right].join(’ ‘)",
    },
  });

  assert.equal(firstText(result), "hello world");
});

test("supports standard JavaScript without math aliases", async () => {
  const result = await client.callTool({
    name: "js_calculator",
    arguments: {
      expression:
        "function sumTo(n) { let sum = 0; for (let i = 1; i <= n; i++) sum += i; return sum; } sumTo(100)",
    },
  });
  assert.equal(firstText(result), "5050");

  const alias = await client.callTool({
    name: "js_calculator",
    arguments: { expression: "typeof sqrt" },
  });
  assert.equal(firstText(alias), "undefined");
});

test("explains how to fix an undefined JavaScript result", async () => {
  const result = await client.callTool({
    name: "js_calculator",
    arguments: { expression: "console.log('answer')" },
  });
  const text = firstText(result);

  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(text, /Script produced undefined/);
  assert.match(text, /final expression/);
  assert.equal(text.includes("tool-registry"), false);
});

test("returns complete JavaScript diagnostics", async () => {
  const result = await client.callTool({
    name: "js_calculator",
    arguments: { expression: String.raw`let S=0;\nfor(let i=1;i<=3;i++)S^=i;\nS` },
  });
  const text = firstText(result);

  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(text, /^calculator\.js:1/m);
  assert.match(text, /let S=0;\\nfor/);
  assert.match(text, /^\s*\^$/m);
  assert.match(text, /SyntaxError: Invalid or unexpected token/);
  assert.match(text, /at new Script/);
});

test("runs commands and returns readable current time", async () => {
  const command = await client.callTool({
    name: "run_cmd",
    arguments: { command: "node -e \"process.stdout.write('ok')\"" },
  });
  assert.equal(firstText(command), "ok");

  const failedCommandText =
    "node -e \"process.stderr.write('unique failure'); process.exit(2)\"";
  const failedCommand = await client.callTool({
    name: "run_cmd",
    arguments: { command: failedCommandText },
  });
  const failedText = firstText(failedCommand);
  assert.match(failedText, /\[exit code: 2\]/);
  assert.match(failedText, /unique failure/);
  assert.equal(failedText.includes(failedCommandText), false);

  const time = await client.callTool({
    name: "get_current_time",
    arguments: { timezone: "Asia/Bangkok" },
  });
  assert.match(firstText(time), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/);
  assert.equal(firstText(time).includes("Asia/Bangkok"), false);
});
