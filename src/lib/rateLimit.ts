/**
 * Serverless-friendly rate limiter — src/lib/rateLimit.ts:1
 * Tries Upstash Redis if UPSTASH_REDIS_REST_URL + TOKEN present, otherwise in-memory Map fallback.
 * Designed for Vercel stateless functions (arch §3.4).
 */

import { Redis } from "@upstash/redis";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  reset: number; // epoch ms when window resets
  limit: number;
}

// ---------------------------------------------------------------------------
// Upstash client singleton (lazy)
// ---------------------------------------------------------------------------

let upstashClient: Redis | null | undefined = undefined; // undefined = not yet checked

function getUpstashClient(): Redis | null {
  if (upstashClient !== undefined) return upstashClient;

  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (url && token) {
    try {
      upstashClient = new Redis({ url, token });
      return upstashClient;
    } catch (err) {
      console.warn("[rateLimit] Upstash client init failed, falling back to memory:", err);
      upstashClient = null;
      return null;
    }
  }

  upstashClient = null;
  return null;
}

// ---------------------------------------------------------------------------
// In-memory fallback (per-instance). Use globalThis to survive HMR.
// ---------------------------------------------------------------------------

type MemoryEntry = { count: number; resetAt: number };

function getMemoryStore(): Map<string, MemoryEntry> {
  const g = globalThis as unknown as { __rateLimitMem?: Map<string, MemoryEntry> };
  if (!g.__rateLimitMem) g.__rateLimitMem = new Map<string, MemoryEntry>();
  return g.__rateLimitMem;
}

function checkMemory(
  identifier: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const store = getMemoryStore();
  const now = Date.now();
  const entry = store.get(identifier);

  // Periodic cleanup of expired entries (10% chance per call to avoid O(n) every time)
  if (Math.random() < 0.1) {
    for (const [k, v] of store.entries()) {
      if (v.resetAt <= now) store.delete(k);
    }
  }

  if (!entry || entry.resetAt <= now) {
    const resetAt = now + windowMs;
    store.set(identifier, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, reset: resetAt, limit };
  }

  entry.count += 1;
  store.set(identifier, entry);

  const allowed = entry.count <= limit;
  const remaining = Math.max(0, limit - entry.count);
  return { allowed, remaining, reset: entry.resetAt, limit };
}

// ---------------------------------------------------------------------------
// Upstash path (fixed window via INCR + EXPIRE)
// ---------------------------------------------------------------------------

async function checkUpstash(
  redis: Redis,
  identifier: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const key = `ratelimit:${identifier}`;
  const windowSec = Math.ceil(windowMs / 1000);

  // Use pipeline where possible but keep simple for compatibility across @upstash/redis versions
  // INCR returns new count
  const count = (await redis.incr(key)) as number;

  let ttlSec: number | null = null;
  try {
    // If first increment, set expiry. Also handle missing TTL.
    if (count === 1) {
      await redis.expire(key, windowSec);
      ttlSec = windowSec;
    } else {
      ttlSec = (await redis.ttl(key)) as number;
      // Upstash may return -1 if no expire set (shouldn't happen) or -2 if key missing; handle defensively
      if (ttlSec === -1 || ttlSec === -2 || ttlSec === null) {
        await redis.expire(key, windowSec);
        ttlSec = windowSec;
      }
    }
  } catch {
    // If ttl/expire fails, estimate reset
    ttlSec = windowSec;
  }

  const now = Date.now();
  const reset = now + (ttlSec ?? windowSec) * 1000;
  const allowed = count <= limit;
  const remaining = Math.max(0, limit - count);

  return { allowed, remaining, reset, limit };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check rate limit for identifier (IP or IP+session).
 * Default: 10 requests per 60s (arch §3.4).
 * Automatically picks Upstash if env vars present, else in-memory.
 */
export async function checkRateLimit(
  identifier: string,
  limit = 10,
  windowMs = 60000
): Promise<RateLimitResult> {
  if (!identifier || typeof identifier !== "string" || identifier.trim().length === 0) {
    throw new Error("checkRateLimit: identifier must be a non-empty string");
  }
  if (limit <= 0 || limit > 1000) throw new Error("checkRateLimit: limit must be 1..1000");
  if (windowMs <= 0) throw new Error("checkRateLimit: windowMs must be positive");

  const normalized = identifier.trim().slice(0, 256);
  const redis = getUpstashClient();

  if (redis) {
    try {
      return await checkUpstash(redis, normalized, limit, windowMs);
    } catch (err) {
      console.warn("[rateLimit] Upstash check failed, falling back to memory:", err instanceof Error ? err.message : err);
      return checkMemory(normalized, limit, windowMs);
    }
  }

  return checkMemory(normalized, limit, windowMs);
}

/**
 * Reset helpers for tests.
 */
export function _resetRateLimitForTests(): void {
  upstashClient = undefined;
  const g = globalThis as unknown as { __rateLimitMem?: Map<string, MemoryEntry> };
  if (g.__rateLimitMem) g.__rateLimitMem.clear();
}
