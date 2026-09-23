export interface SdModelInfo {
  name?: string;
  path?: string;
  stem?: string;
}

export interface SdCapabilities {
  current_mode?: string;
  supported_modes?: string[];
  model?: SdModelInfo;
  samplers?: string[];
  schedulers?: string[];
  limits?: {
    min_width?: number;
    max_width?: number;
    min_height?: number;
    max_height?: number;
    max_batch_count?: number;
    max_queue_size?: number;
  };
  defaults_by_mode?: Record<string, unknown>;
  loras?: Array<{ name?: string; path?: string }>;
}

export function detectLcmLora(
  capabilities?: SdCapabilities | null,
): { name?: string; path?: string } | null {
  if (!capabilities?.loras || !Array.isArray(capabilities.loras)) {
    return null;
  }
  for (const lora of capabilities.loras) {
    const target = `${lora.name ?? ""} ${lora.path ?? ""}`.toLowerCase();
    if (target.includes("lcm")) {
      return lora;
    }
  }
  return null;
}

export interface ImgGenRequest {
  prompt: string;
  negative_prompt?: string;
  lora?: Array<{ path: string; multiplier?: number }>;
  width?: number;
  height?: number;
  clip_skip?: number;
  seed?: number;
  batch_count?: number;
  sample_params?: {
    scheduler?: string;
    sample_method?: string;
    sample_steps?: number;
    guidance?: {
      txt_cfg?: number;
      img_cfg?: number | null;
      distilled_guidance?: number;
    };
  };
  vae_tiling_params?: {
    enabled?: boolean;
    temporal_tiling?: boolean;
    tile_size_x?: number;
    tile_size_y?: number;
    target_overlap?: number;
    rel_size_x?: number;
    rel_size_y?: number;
    extra_tiling_args?: string;
  };
  output_format?: string;
  output_compression?: number;
}

export interface JobResultImage {
  index: number;
  b64_json: string;
}

export interface JobResponse {
  id: string;
  kind: string;
  status: "queued" | "generating" | "completed" | "failed" | "cancelled";
  created?: number;
  started?: number | null;
  completed?: number | null;
  queue_position?: number;
  result?: {
    output_format?: string;
    images?: JobResultImage[];
  } | null;
  error?: {
    code?: string;
    message?: string;
  } | null;
}

export const DEFAULT_SD_SERVER_URL = "http://127.0.0.1:4444";

export async function probeSdServer(
  baseUrl = DEFAULT_SD_SERVER_URL,
  timeoutMs = 1500,
): Promise<SdCapabilities | null> {
  const cleanUrl = baseUrl.replace(/\/+$/, "");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${cleanUrl}/sdcpp/v1/capabilities`, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);

    if (!response.ok) {
      return null;
    }
    return (await response.json()) as SdCapabilities;
  } catch {
    return null;
  }
}

export async function submitImgGen(
  request: ImgGenRequest,
  baseUrl = DEFAULT_SD_SERVER_URL,
  signal?: AbortSignal,
): Promise<{ id: string; poll_url: string }> {
  const cleanUrl = baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${cleanUrl}/sdcpp/v1/img_gen`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
    },
    body: JSON.stringify(request),
    signal,
  });

  if (response.status !== 202 && !response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`sd-server rejected img_gen (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as { id: string; poll_url?: string };
  return {
    id: data.id,
    poll_url: data.poll_url ?? `/sdcpp/v1/jobs/${data.id}`,
  };
}

export async function pollJob(
  jobId: string,
  baseUrl = DEFAULT_SD_SERVER_URL,
  timeoutMs = 0,
  pollIntervalMs = 5000,
  signal?: AbortSignal,
): Promise<JobResponse> {
  const cleanUrl = baseUrl.replace(/\/+$/, "");
  const startTime = Date.now();

  while (true) {
    if (signal?.aborted) {
      throw new Error("Job polling aborted");
    }

    if (timeoutMs > 0 && Date.now() - startTime >= timeoutMs) {
      throw new Error(`Job ${jobId} timed out after ${timeoutMs / 1000}s`);
    }

    const response = await fetch(`${cleanUrl}/sdcpp/v1/jobs/${encodeURIComponent(jobId)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Failed to query job status (${response.status}): ${errText}`);
    }

    const job = (await response.json()) as JobResponse;

    if (job.status === "completed") {
      return job;
    }
    if (job.status === "failed") {
      throw new Error(job.error?.message || `Job ${jobId} failed`);
    }
    if (job.status === "cancelled") {
      throw new Error(`Job ${jobId} was cancelled`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
