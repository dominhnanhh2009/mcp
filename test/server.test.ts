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

  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
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

test("lists all built-in tools", async () => {
  const result = await client.listTools();
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    [
      "ls",
      "read_file",
      "write_file",
      "mkdir",
      "delete_file",
      "run_cmd",
      "js_calculator",
      "get_current_time",
    ],
  );
});

test("writes and reads a file", async () => {
  await client.callTool({
    name: "write_file",
    arguments: { path: "notes/hello.txt", content: "xin chào" },
  });
  const result = await client.callTool({
    name: "read_file",
    arguments: { path: "notes/hello.txt" },
  });

  assert.equal(await readFile(path.join(workspace, "notes/hello.txt"), "utf8"), "xin chào");
  assert.equal(firstText(result), "xin chào");
});

test("calculates JavaScript math expressions", async () => {
  const result = await client.callTool({
    name: "js_calculator",
    arguments: { expression: "pow(2, 10) + log(E)" },
  });
  assert.equal(JSON.parse(firstText(result)).result, 1025);
});

test("runs commands and returns readable current time", async () => {
  const command = await client.callTool({
    name: "run_cmd",
    arguments: { command: "node -e \"process.stdout.write('ok')\"" },
  });
  assert.equal(JSON.parse(firstText(command)).stdout, "ok");

  const time = await client.callTool({
    name: "get_current_time",
    arguments: { timezone: "Asia/Bangkok" },
  });
  const parsed = JSON.parse(firstText(time));
  assert.equal(parsed.timezone, "Asia/Bangkok");
  assert.match(parsed.human_readable, /\d{4}/);
});
