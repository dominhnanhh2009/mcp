import { createWriteStream } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import AdmZip from "adm-zip";

const QDRANT_VERSION = "1.19.0";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a Qdrant port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function ensureBinary(): Promise<string> {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Automatic Qdrant download currently supports Windows x64 only");
  }
  const directory = path.resolve(process.cwd(), "runtime", "qdrant");
  const executable = path.join(directory, "qdrant.exe");
  try {
    await access(executable);
    return executable;
  } catch {}

  await mkdir(directory, { recursive: true });
  const archive = path.join(directory, "qdrant.zip.download");
  const url = `https://github.com/qdrant/qdrant/releases/download/v${QDRANT_VERSION}/qdrant-x86_64-pc-windows-msvc.zip`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Could not download Qdrant: HTTP ${response.status}`);
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archive));
    new AdmZip(archive).extractAllTo(directory, true);
  } finally {
    await rm(archive, { force: true });
  }
  await access(executable);
  return executable;
}

async function waitUntilReady(baseUrl: string, processHandle: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`Qdrant exited with code ${processHandle.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Qdrant did not become ready");
}

export class QdrantStore {
  private constructor(
    private readonly baseUrl: string,
    private readonly child: ChildProcess,
    private readonly collection: string,
  ) {}

  static async start(cwd: string, dimensions: number): Promise<QdrantStore> {
    const executable = await ensureBinary();
    const port = await availablePort();
    const storage = path.join(cwd, ".memory", "qdrant-storage");
    await mkdir(storage, { recursive: true });
    const child = spawn(executable, [], {
      cwd: path.dirname(executable),
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        QDRANT__SERVICE__HOST: "127.0.0.1",
        QDRANT__SERVICE__HTTP_PORT: String(port),
        QDRANT__SERVICE__GRPC_PORT: String(port + 1),
        QDRANT__STORAGE__STORAGE_PATH: storage,
      },
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitUntilReady(baseUrl, child);
      const store = new QdrantStore(baseUrl, child, "memories");
      await store.request(`/collections/${store.collection}`, {
        method: "PUT",
        body: JSON.stringify({ vectors: { size: dimensions, distance: "Cosine" } }),
      }, [200, 409]);
      return store;
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  private async request(pathname: string, init: RequestInit, accepted = [200]): Promise<unknown> {
    const response = await fetch(this.baseUrl + pathname, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(10_000),
    });
    if (!accepted.includes(response.status)) {
      const detail = await response.text();
      throw new Error(`Qdrant returned HTTP ${response.status}: ${detail}`);
    }
    return response.json();
  }

  async remember(id: string, chunk: string, vector: number[]): Promise<void> {
    await this.request(`/collections/${this.collection}/points?wait=true`, {
      method: "PUT",
      body: JSON.stringify({ points: [{ id, vector, payload: { chunk } }] }),
    });
  }

  async query(vector: number[], limit: number): Promise<Array<{ id: string | number; score: number; chunk: string }>> {
    const body = await this.request(`/collections/${this.collection}/points/query`, {
      method: "POST",
      body: JSON.stringify({ query: vector, limit, with_payload: true }),
    }) as { result?: { points?: Array<{ id: string | number; score: number; payload?: { chunk?: unknown } }> } };
    return (body.result?.points ?? []).flatMap((point) =>
      typeof point.payload?.chunk === "string"
        ? [{ id: point.id, score: point.score, chunk: point.payload.chunk }]
        : []
    );
  }

  async forget(id: string): Promise<void> {
    await this.request(`/collections/${this.collection}/points/delete?wait=true`, {
      method: "POST",
      body: JSON.stringify({ points: [id] }),
    });
  }

  stop(): void {
    this.child.kill();
  }
}
