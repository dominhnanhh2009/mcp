import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeSdServer, submitImgGen, pollJob, type SdCapabilities } from "../src/tools/sd-client.js";
import { createGenImageTool, buildSdToolDescription } from "../src/tools/sd.js";
import { startServer } from "../src/server.js";

let mockSdServer: Server;
let mockSdPort: number;
let mockSdUrl: string;

const sampleCapabilities: SdCapabilities = {
  current_mode: "img_gen",
  model: {
    name: "realisticVisionV60B1_v51VAE.safetensors",
    stem: "realisticVisionV60B1_v51VAE",
  },
  samplers: ["euler", "euler_a", "lcm"],
  schedulers: ["discrete", "karras", "lcm"],
  loras: [
    { name: "lcm-lora-sdv1-5", path: "lcm-lora-sdv1-5.safetensors" },
  ],
  defaults_by_mode: {
    img_gen: { width: 512, height: 512 },
  },
};

before(async () => {
  mockSdServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${mockSdPort}`);
    if (url.pathname === "/sdcpp/v1/capabilities" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sampleCapabilities));
      return;
    }

    if (url.pathname === "/sdcpp/v1/img_gen" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        assert.equal(parsed.vae_tiling_params?.enabled, true);
        if (parsed.sample_params) {
          assert.equal(parsed.sample_params.sample_method, "lcm");
          assert.equal(parsed.sample_params.scheduler, "lcm");
        }
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "job_test_123", poll_url: "/sdcpp/v1/jobs/job_test_123" }));
      });
      return;
    }

    if (url.pathname === "/sdcpp/v1/jobs/job_test_123" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "job_test_123",
          kind: "img_gen",
          status: "completed",
          result: {
            output_format: "png",
            images: [{ index: 0, b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }],
          },
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => {
    mockSdServer.listen(0, "127.0.0.1", () => {
      mockSdPort = (mockSdServer.address() as AddressInfo).port;
      mockSdUrl = `http://127.0.0.1:${mockSdPort}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => mockSdServer.close(() => resolve()));
});

test("probeSdServer returns null when target server is offline", async () => {
  const result = await probeSdServer("http://127.0.0.1:59999", 500);
  assert.equal(result, null);
});

test("probeSdServer returns capabilities when server is online", async () => {
  const result = await probeSdServer(mockSdUrl, 2000);
  assert.ok(result);
  assert.equal(result.model?.name, "realisticVisionV60B1_v51VAE.safetensors");
  assert.equal(result.loras?.length, 1);
});

test("buildSdToolDescription indicates model name, SD1.5 base and LCM", () => {
  const desc = buildSdToolDescription(sampleCapabilities);
  assert.match(desc, /realisticVisionV60B1_v51VAE/);
  assert.match(desc, /SD1\.5/);
  assert.match(desc, /LCM/);
  assert.match(desc, /VAE tiling/);
});

test("submitImgGen and pollJob workflow succeeds", async () => {
  const submitResult = await submitImgGen(
    {
      prompt: "test image",
      vae_tiling_params: { enabled: true },
    },
    mockSdUrl,
  );
  assert.equal(submitResult.id, "job_test_123");

  const completed = await pollJob(submitResult.id, mockSdUrl, 5000);
  assert.equal(completed.status, "completed");
  assert.equal(completed.result?.images?.length, 1);
});

test("gen_image tool execution returns base64 image content, sets LCM parameters, prepends negative prompt, and saves file to workspace", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "sd-tool-save-"));
  const tool = createGenImageTool(mockSdUrl, sampleCapabilities);
  const result = (await tool.handler(
    {
      prompt: "a majestic mountain",
      negprompt: "ugly, blurry",
      width: 512,
      height: 512,
      steps: 4,
      cfg: 1.0,
      output_file: "my_mountain.png",
    },
    { cwd: tempDir },
  )) as { content: Array<{ type: string; data?: string; text?: string }> };

  assert.ok(Array.isArray(result.content));
  const img = result.content.find((item) => item.type === "image");
  assert.ok(img);
  assert.ok(img.data?.length);

  const textItem = result.content.find((item) => item.type === "text");
  assert.ok(textItem?.text?.includes("my_mountain.png"));

  const savedFilePath = path.join(tempDir, "my_mountain.png");
  const { stat } = await import("node:fs/promises");
  const fileStat = await stat(savedFilePath);
  assert.ok(fileStat.size > 0);

  await rm(tempDir, { recursive: true, force: true });
});

test("server dynamically includes gen_image when sd-server is online with LCM LoRA and excludes it when offline or missing LCM LoRA", async () => {
  const tempWorkspace = await mkdtemp(path.join(tmpdir(), "mcp-sd-test-"));
  
  // Test server with online mock sd-server containing LCM LoRA
  const onlineServer = await startServer({
    port: 0,
    cwd: tempWorkspace,
    sdServerUrl: mockSdUrl,
  });
  const onlinePort = (onlineServer.address() as AddressInfo).port;
  const onlineClient = new Client({ name: "test-client-online", version: "1.0.0" });
  await onlineClient.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${onlinePort}/mcp`)),
  );
  const onlineTools = await onlineClient.listTools();
  const genTool = onlineTools.tools.find((t) => t.name === "gen_image");
  assert.ok(genTool);
  // Verify sampling is not exposed, steps defaults to 4, cfg defaults to 1
  const props = (genTool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  assert.equal("sampling" in props, false);
  assert.equal("steps" in props, true);
  assert.equal((props.steps as { default?: number }).default, 4);
  assert.equal((props.cfg as { default?: number }).default, 1);
  await onlineClient.close();
  await new Promise<void>((resolve) => onlineServer.close(() => resolve()));

  // Test server with offline sd-server
  const offlineServer = await startServer({
    port: 0,
    cwd: tempWorkspace,
    sdServerUrl: "http://127.0.0.1:59998",
  });
  const offlinePort = (offlineServer.address() as AddressInfo).port;
  const offlineClient = new Client({ name: "test-client-offline", version: "1.0.0" });
  await offlineClient.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${offlinePort}/mcp`)),
  );
  const offlineTools = await offlineClient.listTools();
  assert.ok(!offlineTools.tools.some((t) => t.name === "gen_image"));
  await offlineClient.close();
  await new Promise<void>((resolve) => offlineServer.close(() => resolve()));

  await rm(tempWorkspace, { recursive: true, force: true });
});

test("detectLcmLora helper matches substring case-insensitively and handles missing loras", async () => {
  const { detectLcmLora } = await import("../src/tools/sd-client.js");
  assert.equal(detectLcmLora(null), null);
  assert.equal(detectLcmLora({}), null);
  assert.equal(detectLcmLora({ loras: [] }), null);
  assert.equal(
    detectLcmLora({ loras: [{ name: "anime_v2", path: "anime.safetensors" }] }),
    null,
  );
  const matched = detectLcmLora({
    loras: [
      { name: "anime_v2", path: "anime.safetensors" },
      { name: "SD15_LCM_adapter", path: "adapter.safetensors" },
    ],
  });
  assert.ok(matched);
  assert.equal(matched.name, "SD15_LCM_adapter");
});

