/**
 * Local embeddings — src/lib/embeddingsLocal.ts
 * Free offline fallback using @xenova/transformers + all-MiniLM-L6-v2 (384 dims).
 * Used when OPENAI_API_KEY is missing or has insufficient_quota.
 * NOTE: Vectors from MiniLM are NOT comparable with OpenAI text-embedding-3-small (1536 dims) — never mix.
 * Choose ONE model for both ingestion and query, per ADR-2.
 */

let pipelinePromise: Promise<any> | null = null;
let cachedPipeline: any = null;

export const LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2" as const;
export const LOCAL_EMBEDDING_DIMS = 384 as const;

async function getPipeline() {
  if (cachedPipeline) return cachedPipeline;
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    // Dynamic import to avoid loading in non-local paths
    const mod = await import("@xenova/transformers");
    // @ts-ignore
    const { pipeline, env } = mod;
    // Disable telemetry, allow local cache
    // @ts-ignore
    if (env) {
      // @ts-ignore
      env.allowRemoteModels = true;
      // @ts-ignore
      env.allowLocalModels = true;
    }
    const pipe = await pipeline("feature-extraction", LOCAL_EMBEDDING_MODEL, {
      quantized: true, // smaller, faster
    });
    cachedPipeline = pipe;
    return pipe;
  })();
  return pipelinePromise;
}

export async function embedTextHF(text: string): Promise<number[]> {
  if (typeof text !== "string" || text.trim().length === 0) throw new Error("embedTextHF: empty");
  const trimmed = text.trim().slice(0, 8000);
  const hfKey = process.env.HF_API_KEY?.trim() || process.env.HF_TOKEN?.trim() || "";
  const url = "https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2";
  const headers: Record<string,string> = { "Content-Type": "application/json" };
  if (hfKey) headers["Authorization"] = `Bearer ${hfKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ inputs: trimmed, options: { wait_for_model: true } }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HF API ${res.status}: ${txt.slice(0,300)}`);
  }
  const data = await res.json();
  // HF returns number[] for single input (384) or number[][] for batch
  let arr: number[];
  if (Array.isArray(data) && typeof data[0] === "number") arr = data as number[];
  else if (Array.isArray(data) && Array.isArray(data[0])) {
    // Mean pooling already done by pipeline, but if batched, take first
    arr = (data as number[][])[0];
  } else {
    throw new Error(`HF unexpected response: ${JSON.stringify(data).slice(0,300)}`);
  }
  // Normalize (HF pipeline with normalize:true already, but ensure)
  const norm = Math.sqrt(arr.reduce((s,v)=>s+v*v,0)) || 1;
  const normalized = arr.map(v=>v/norm);
  if (normalized.length !== LOCAL_EMBEDDING_DIMS) console.warn(`[embedHF] dims ${normalized.length} != ${LOCAL_EMBEDDING_DIMS}`);
  return normalized;
}

export async function embedTextLocal(text: string): Promise<number[]> {
  if (typeof text !== "string" || text.trim().length === 0) throw new Error("embedTextLocal: empty");
  const trimmed = text.trim().slice(0, 8000);
  // On Vercel (serverless), @xenova/transformers fails due to missing libonnxruntime.so — use HF API instead
  const isVercel = !!process.env.VERCEL || !!process.env.VERCEL_ENV;
  if (isVercel) {
    try {
      return await embedTextHF(trimmed);
    } catch (e) {
      console.warn(`[embedLocal] HF fallback failed on Vercel, trying local pipeline as last resort: ${e instanceof Error ? e.message.slice(0,120) : String(e)}`);
      // fall through to local pipeline
    }
  }
  const pipe = await getPipeline();
  // Xenova pipeline returns Tensor with mean pooling + normalize options
  const output = await pipe(trimmed, { pooling: "mean", normalize: true });
  // output is Tensor; .data is Float32Array
  let arr: number[];
  if (output?.data) {
    arr = Array.from(output.data as Float32Array);
  } else if (Array.isArray(output)) {
    arr = output;
  } else {
    throw new Error("Local embedding returned unexpected shape");
  }
  if (arr.length !== LOCAL_EMBEDDING_DIMS) {
    console.warn(`[embedLocal] dims ${arr.length} != expected ${LOCAL_EMBEDDING_DIMS}`);
  }
  return arr;
}

export async function embedBatchLocal(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    const v = await embedTextLocal(texts[i]);
    out.push(v);
  }
  return out;
}

export function isLocalEmbeddingAvailable(): boolean {
  // Always true if package installed; we lazy-load
  return true;
}
