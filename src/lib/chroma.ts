/**
 * Chroma Cloud client wrapper — src/lib/chroma.ts:1
 * Hosted vector DB adapter for Vercel serverless (ADR-1).
 * Uses `chromadb` npm package with CloudClient. Falls back to clear error if env not configured.
 */

import { CloudClient, ChromaClient } from "chromadb";
import type { Collection } from "chromadb";

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function getEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function _getRequiredEnv(name: string): string {
  const v = getEnv(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
void _getRequiredEnv;

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

let chromaClient: ChromaClient | null = null;
let cachedCollection: Collection | null = null;

function getChromaClient(): ChromaClient {
  if (chromaClient) return chromaClient;

  const apiKey = getEnv("CHROMA_API_KEY");
  const tenant = getEnv("CHROMA_TENANT");
  const database = getEnv("CHROMA_DATABASE");

  // Clear error for local dev without Chroma — per spec: "Provide fallback for local dev without Chroma (throw clear error)"
  if (!apiKey) {
    throw new Error(
      "Chroma Cloud not configured: missing CHROMA_API_KEY. " +
        "Set CHROMA_API_KEY, CHROMA_TENANT, CHROMA_DATABASE, CHROMA_COLLECTION in .env.local or Vercel dashboard. " +
        "This is expected in local dev without a Chroma Cloud collection — ingestion/query will fail until configured."
    );
  }

  // Prefer CloudClient for Chroma Cloud (api.trychroma.com). Falls back to ChromaClient if CloudClient unavailable.
  try {
    chromaClient = new CloudClient({
      apiKey,
      tenant: tenant ?? undefined,
      database: database ?? undefined,
    });
  } catch (err) {
    // Defensive fallback: some chromadb versions expose only ChromaClient
    console.warn("[chroma] CloudClient init failed, falling back to ChromaClient:", err);
    chromaClient = new ChromaClient({
      tenant: tenant ?? undefined,
      database: database ?? undefined,
    } as never);
  }

  return chromaClient;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export function getCollectionName(): string {
  return getEnv("CHROMA_COLLECTION") ?? "sociology";
}

/**
 * Retrieve Chroma Cloud collection handle. Cached after first fetch.
 * Throws clear error if Chroma not configured or collection missing.
 */
export async function getCollection(): Promise<Collection> {
  if (cachedCollection) return cachedCollection;

  const client = getChromaClient();
  const name = getCollectionName();

  try {
    // getCollection will throw if not exists — this surfacing is intentional
    const collection = await client.getCollection({
      name,
    });
    cachedCollection = collection;
    return collection;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to get Chroma collection "${name}": ${msg}. Did you run ingestion against CHROMA_COLLECTION=${name}?`);
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface ChromaChunk {
  id: string;
  text: string;
  metadata: Record<string, unknown> & { page?: number | string; source?: string };
  distance: number | null;
  similarity: number | null;
}

/**
 * Query collection by precomputed embedding.
 * Converts Chroma distances to cosine similarities (similarity = 1 - distance for cosine space).
 */
export async function queryCollection(
  embedding: number[],
  topK = 5
): Promise<ChromaChunk[]> {
  if (!embedding || embedding.length === 0) {
    throw new Error("queryCollection: embedding must be a non-empty number[]");
  }
  if (topK <= 0 || topK > 20) {
    throw new Error("queryCollection: topK must be between 1 and 20");
  }

  const collection = await getCollection();

  const result = await collection.query({
    queryEmbeddings: [embedding],
    nResults: topK,
    include: ["documents", "metadatas", "distances"] as never,
  });

  // Chroma returns batched arrays: documents[0] is array of topK for first query
  const documents = result.documents?.[0] ?? [];
  const metadatas = result.metadatas?.[0] ?? [];
  const distances = result.distances?.[0] ?? [];
  const ids = result.ids?.[0] ?? [];

  const chunks: ChromaChunk[] = documents.map((doc, i) => {
    const dist = distances[i] ?? null;
    return {
      id: ids[i] ?? `chunk-${i}`,
      text: doc ?? "",
      metadata: (metadatas[i] as ChromaChunk["metadata"]) ?? {},
      distance: dist,
      similarity: dist !== null ? distanceToSimilarity(dist) : null,
    };
  });

  return chunks;
}

// ---------------------------------------------------------------------------
// Similarity / confidence helpers — also exported for rag.ts
// ---------------------------------------------------------------------------

/**
 * Convert Chroma distance to cosine similarity.
 * Chroma Cloud with cosine space: distance = 1 - cosineSimilarity, range [0,2].
 * For L2, this is an approximation but preserves ordering; we document the assumption.
 */
export function distanceToSimilarity(distance: number): number {
  if (typeof distance !== "number" || Number.isNaN(distance)) return 0;
  // Clamp to [0,2] before conversion to avoid >1 similarity from anomalous values
  const clamped = Math.max(0, Math.min(2, distance));
  return 1 - clamped;
}

/**
 * Compute similarities from distances array.
 */
export function distancesToSimilarities(distances: (number | null)[]): number[] {
  return distances.map((d) => (d === null || d === undefined ? 0 : distanceToSimilarity(d)));
}

/**
 * Confidence gate helper — returns true if top similarity meets threshold.
 * Threshold default 0.3 per architecture §A.4 / PRD (low similarity → refuse before LLM call).
 * Also exported from rag.ts, this is the chroma-side utility for reuse.
 */
export function passesConfidenceGate(
  similarities: number[],
  threshold = 0.3
): { passed: boolean; topSimilarity: number } {
  if (!similarities || similarities.length === 0) {
    return { passed: false, topSimilarity: 0 };
  }
  const top = Math.max(...similarities);
  return { passed: top >= threshold, topSimilarity: top };
}

/**
 * Convenience: run confidence gate directly on distances.
 */
export function confidenceGateFromDistances(
  distances: (number | null)[],
  threshold = 0.3
): { passed: boolean; topSimilarity: number } {
  return passesConfidenceGate(distancesToSimilarities(distances), threshold);
}

/**
 * Reset caches — useful for tests.
 */
export function _resetChromaForTests(): void {
  chromaClient = null;
  cachedCollection = null;
}
