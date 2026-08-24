import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import { LlamaEmbeddings } from "./llama-embeddings.js";
import { QdrantStore } from "./qdrant.js";

export interface MemoryRuntime {
  model: string;
  tools: ToolDefinition[];
  stop(): void;
}

export async function startMemory(cwd: string, llamaServerUrl?: string): Promise<MemoryRuntime | undefined> {
  if (!llamaServerUrl) return undefined;
  const embeddings = await LlamaEmbeddings.discover(llamaServerUrl);
  if (!embeddings) return undefined;
  const store = await QdrantStore.start(cwd, embeddings.dimensions);

  const tools: ToolDefinition[] = [
    {
      name: "memory_query",
      description: "Search durable memory chunks by semantic similarity. Returns the top matches with IDs that can be passed to forget.",
      inputSchema: {
        query: z.string().min(1),
        top_k: z.number().int().min(1).max(100).default(5),
      },
      handler: async ({ query, top_k }) =>
        store.query(await embeddings.embed(query as string), top_k as number),
    },
    {
      name: "remember",
      description: "Store one durable memory chunk and return its ID.",
      inputSchema: { chunk: z.string().min(1) },
      handler: async ({ chunk }) => {
        const id = randomUUID();
        await store.remember(id, chunk as string, await embeddings.embed(chunk as string));
        return id;
      },
    },
    {
      name: "forget",
      description: "Delete one durable memory chunk by its ID.",
      inputSchema: { id: z.string().uuid() },
      handler: async ({ id }) => {
        await store.forget(id as string);
        return "OK";
      },
    },
  ];
  return { model: embeddings.model, tools, stop: () => store.stop() };
}
