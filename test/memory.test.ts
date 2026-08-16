import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { LlamaEmbeddings } from "../src/memory/llama-embeddings.js";

async function mockLlama(models: string[]): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/models") {
      response.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    if (request.url === "/v1/embeddings" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const model = JSON.parse(body).model;
        response.end(JSON.stringify({
          data: [{ embedding: model === "my-embed-model" ? [0.1, 0.2, 0.3] : [] }],
        }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

test("selects the first model whose ID contains embed", async () => {
  const llama = await mockLlama(["chat-model", "my-embed-model", "later-embed"]);
  try {
    const selected = await LlamaEmbeddings.discover(llama.url);
    assert.equal(selected?.model, "my-embed-model");
    assert.equal(selected?.dimensions, 3);
  } finally {
    await llama.close();
  }
});

test("does not probe models whose IDs lack embed", async () => {
  const llama = await mockLlama(["chat-model", "vector-model"]);
  try {
    assert.equal(await LlamaEmbeddings.discover(llama.url), undefined);
  } finally {
    await llama.close();
  }
});
