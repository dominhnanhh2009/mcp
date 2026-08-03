import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      "Prefer dedicated tools over run_cmd. " +
      "Use find for partial file edits and write_file for complete files. " +
      "Tool failures are returned as MCP error results.",
  );

  const result = await client.listTools();
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    [
      "ls",
      "read_file",
      "write_file",
      "find",
      "mkdir",
      "delete_file",
      "run_cmd",
      "js_calculator",
      "get_current_time",
    ],
  );
  assert.match(
    result.tools.find((tool) => tool.name === "run_cmd")?.description ?? "",
    /without sandboxing when no dedicated tool applies/,
  );
  assert.match(
    result.tools.find((tool) => tool.name === "delete_file")?.description ?? "",
    /Stop any process holding it/,
  );
  assert.match(
    result.tools.find((tool) => tool.name === "js_calculator")?.description ?? "",
    /final expression/,
  );
  assert.match(
    result.tools.find((tool) => tool.name === "js_calculator")?.description ?? "",
    /Do not use console\.log/,
  );
  assert.match(
    result.tools.find((tool) => tool.name === "js_calculator")?.description ?? "",
    /xs\.map/,
  );
});

test("writes and reads a file", async () => {
  const write = await client.callTool({
    name: "write_file",
    arguments: { path: "notes/hello.txt", content: "xin chào" },
  });
  const result = await client.callTool({
    name: "read_file",
    arguments: { path: "notes/hello.txt" },
  });

  assert.equal(await readFile(path.join(workspace, "notes/hello.txt"), "utf8"), "xin chào");
  assert.deepEqual(JSON.parse(firstText(write)), { bytes_written: 9 });
  assert.equal(firstText(write).includes("notes/hello.txt"), false);
  assert.equal(firstText(write).includes("xin chào"), false);
  assert.equal(firstText(result), "xin chào");
});

test("normalizes typographic quotes when writing JavaScript and TypeScript", async () => {
  const javascript = "const greeting = \u201chello\u201d; greeting";
  const typescript = "const greeting: string = \u2018hello\u2019; greeting";

  await client.callTool({
    name: "write_file",
    arguments: { path: "src/greeting.js", content: javascript },
  });
  await client.callTool({
    name: "write_file",
    arguments: { path: "src/greeting.ts", content: typescript },
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
    name: "write_file",
    arguments: { path: "notes/quotes.txt", content },
  });

  assert.equal(
    await readFile(path.join(workspace, "notes/quotes.txt"), "utf8"),
    content,
  );
});

test("finds case-insensitively and replaces one closest match", async () => {
  await client.callTool({
    name: "write_file",
    arguments: {
      path: "notes/find.txt",
      content: "before The quick brown fox after",
    },
  });

  const result = await client.callTool({
    name: "find",
    arguments: {
      file: "notes/find.txt",
      content: "the quick brown fix",
      replacement: "the slow fox",
    },
  });

  assert.equal(
    await readFile(path.join(workspace, "notes/find.txt"), "utf8"),
    "before the slow fox after",
  );
  const response = JSON.parse(firstText(result));
  assert.equal(response.success, true);
  assert.ok(response.match_percentage >= 90);
  assert.match(response.review, /the slow fox/);
});

test("find does not edit ambiguous or low-confidence matches", async () => {
  const ambiguous = "repeat me / repeat me";
  await client.callTool({
    name: "write_file",
    arguments: { path: "notes/ambiguous.txt", content: ambiguous },
  });
  const tied = await client.callTool({
    name: "find",
    arguments: {
      file: "notes/ambiguous.txt",
      content: "repeat me",
      replacement: "changed",
    },
  });
  assert.equal((tied as { isError?: boolean }).isError, true);
  assert.match(firstText(tied), /Found 2 matches/);
  assert.equal(
    await readFile(path.join(workspace, "notes/ambiguous.txt"), "utf8"),
    ambiguous,
  );

  const low = await client.callTool({
    name: "find",
    arguments: {
      file: "notes/ambiguous.txt",
      content: "completely unrelated content",
      replacement: "changed",
    },
  });
  assert.equal((low as { isError?: boolean }).isError, true);
  assert.match(firstText(low), /below the required 90%/);
  assert.equal(
    await readFile(path.join(workspace, "notes/ambiguous.txt"), "utf8"),
    ambiguous,
  );
});

test("find normalizes typographic quotes only for JavaScript files", async () => {
  await client.callTool({
    name: "write_file",
    arguments: { path: "edit.js", content: "const value = 'old';" },
  });
  await client.callTool({
    name: "find",
    arguments: {
      file: "edit.js",
      content: "'old'",
      replacement: "“new”",
    },
  });
  assert.equal(
    await readFile(path.join(workspace, "edit.js"), "utf8"),
    'const value = "new";',
  );
});

test("deletes files created by the filesystem tools", async () => {
  await client.callTool({
    name: "write_file",
    arguments: { path: "temporary/delete-me.txt", content: "temporary" },
  });
  const result = await client.callTool({
    name: "delete_file",
    arguments: { path: "temporary/delete-me.txt" },
  });

  assert.equal(JSON.parse(firstText(result)).deleted, true);
  await assert.rejects(
    readFile(path.join(workspace, "temporary/delete-me.txt"), "utf8"),
    { code: "ENOENT" },
  );
});

test("does not echo input paths in filesystem errors", async () => {
  const missingPath = "private/missing-secret-name.txt";
  const result = await client.callTool({
    name: "read_file",
    arguments: { path: missingPath },
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
  assert.equal(JSON.parse(text).result, 1025);
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

  assert.equal(JSON.parse(firstText(result)).result, "hello world");
});

test("supports standard JavaScript without math aliases", async () => {
  const result = await client.callTool({
    name: "js_calculator",
    arguments: {
      expression:
        "function sumTo(n) { let sum = 0; for (let i = 1; i <= n; i++) sum += i; return sum; } sumTo(100)",
    },
  });
  assert.equal(JSON.parse(firstText(result)).result, 5050);

  const alias = await client.callTool({
    name: "js_calculator",
    arguments: { expression: "typeof sqrt" },
  });
  assert.equal(JSON.parse(firstText(alias)).result, "undefined");
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
  assert.equal(JSON.parse(firstText(command)).stdout, "ok");

  const failedCommandText =
    "node -e \"process.stderr.write('unique failure'); process.exit(2)\"";
  const failedCommand = await client.callTool({
    name: "run_cmd",
    arguments: { command: failedCommandText },
  });
  const failed = JSON.parse(firstText(failedCommand));
  assert.deepEqual(failed, { exit_code: 2, stderr: "unique failure" });
  assert.equal(firstText(failedCommand).includes(failedCommandText), false);
  assert.equal("error" in failed, false);

  const time = await client.callTool({
    name: "get_current_time",
    arguments: { timezone: "Asia/Bangkok" },
  });
  assert.match(firstText(time), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/);
  assert.equal(firstText(time).includes("Asia/Bangkok"), false);
});
