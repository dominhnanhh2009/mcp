interface ModelEntry {
  id?: unknown;
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: unknown }>;
}

function endpoint(baseUrl: string, pathname: string): URL {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/$/, "") + pathname;
  return url;
}

async function jsonRequest(url: URL, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  return response.json();
}

export class LlamaEmbeddings {
  private constructor(
    private readonly baseUrl: string,
    readonly model: string,
    readonly dimensions: number,
  ) {}

  static async discover(baseUrl: string): Promise<LlamaEmbeddings | undefined> {
    let body: unknown;
    try {
      body = await jsonRequest(endpoint(baseUrl, "/models"));
    } catch {
      return undefined;
    }

    const candidates = Array.isArray((body as { data?: unknown })?.data)
      ? ((body as { data: ModelEntry[] }).data)
          .map((item) => item.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];

    const model = candidates.find((candidate) => /embed/i.test(candidate));
    if (!model) return undefined;

    try {
      const probe = new LlamaEmbeddings(baseUrl, model, 0);
      const vector = await probe.embed("embedding capability probe");
      return vector.length > 0 && vector.every(Number.isFinite)
        ? new LlamaEmbeddings(baseUrl, model, vector.length)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async embed(text: string): Promise<number[]> {
    const body = await jsonRequest(endpoint(this.baseUrl, "/v1/embeddings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: text, model: this.model, encoding_format: "float" }),
    }) as EmbeddingResponse;
    const vector = body.data?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.every((value) => typeof value === "number")) {
      throw new Error("llama-server returned an invalid embedding");
    }
    return vector;
  }
}
