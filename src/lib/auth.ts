/**
 * Auth helpers — src/lib/auth.ts:1
 * Implements ADR-4 shared-passphrase gate: HMAC-signed httpOnly session cookie.
 * Uses Node `crypto` (createHmac, timingSafeEqual) for Route Handlers (Node runtime).
 * Middleware (Edge) has its own Web Crypto implementation but token format is compatible.
 *
 * Token format: <payloadB64>.<signatureB64Url>
 *   payloadB64   = base64url(JSON.stringify({ v:1, exp:number, iat:number, nonce:string }))
 *   signature    = base64url( HMAC-SHA256(secret, payloadB64) )
 * Verification checks signature (timingSafeEqual) + expiry.
 */

import { createHmac, timingSafeEqual as nodeTimingSafeEqual, randomBytes } from "crypto";

// ---------------------------------------------------------------------------
// Base64url helpers (Node Buffer)
// ---------------------------------------------------------------------------

function b64UrlEncode(input: string | Buffer): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64url");
}

function b64UrlDecode(b64url: string): string {
  // Buffer handles base64url with or without padding since Node 16+
  return Buffer.from(b64url, "base64url").toString("utf8");
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

export function getAuthSecret(): string | undefined {
  // Preferred: dedicated HMAC secret, fallback to passphrase itself per spec
  const secret =
    process.env.APP_SECRET?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    undefined;
  if (secret) return secret;
  const passphrase =
    process.env.APP_PASSPHRASE?.trim() ||
    process.env.PASSPHRASE?.trim() ||
    process.env.RAG_PASSPHRASE?.trim() ||
    undefined;
  return passphrase;
}

export function getPassphrase(): string | undefined {
  return (
    process.env.APP_PASSPHRASE?.trim() ||
    process.env.PASSPHRASE?.trim() ||
    process.env.RAG_PASSPHRASE?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    undefined
  );
}

// ---------------------------------------------------------------------------
// timingSafeEqual wrapper — constant-time string compare
// Uses Node's timingSafeEqual when lengths equal, otherwise constant-time loop.
// Never throws on length mismatch.
// ---------------------------------------------------------------------------

/**
 * Constant-time string comparison. Returns true iff a === b.
 * Uses Node's `timingSafeEqual` for same-length buffers; otherwise does
 * a constant-time manual loop to avoid early-return timing leak.
 * @example timingSafeCompare("abc", "abc") // true
 */
export function timingSafeCompare(a: string, b: string): boolean {
  // Fast path: use Node timingSafeEqual when buffers same length
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length === bufB.length) {
    try {
      return nodeTimingSafeEqual(bufA, bufB);
    } catch {
      // fallback to manual
    }
  }
  // Different lengths — do constant-time loop over max length + dummy timingSafeEqual
  // to avoid leaking length via timing. Always iterate maxLen.
  const maxLen = Math.max(bufA.length, bufB.length);
  let diff = bufA.length ^ bufB.length; // non-zero if lengths differ
  for (let i = 0; i < maxLen; i++) {
    const ca = i < bufA.length ? bufA[i] : 0;
    const cb = i < bufB.length ? bufB[i] : 0;
    diff |= ca ^ cb;
  }
  // Burn similar time as same-length path by doing a dummy equal-length compare
  try {
    nodeTimingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
  } catch {}
  return diff === 0;
}

/** Alias for spec naming: timingSafeEqual wrapper */
export const timingSafeEqualWrapper = timingSafeCompare;

// ---------------------------------------------------------------------------
// HMAC helpers
// ---------------------------------------------------------------------------

function hmacSha256Base64Url(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("base64url");
}

// ---------------------------------------------------------------------------
// Session token helpers
// ---------------------------------------------------------------------------

export interface SessionPayload {
  v: 1;
  exp: number; // epoch ms
  iat: number; // epoch ms
  nonce: string; // hex 16 chars (8 bytes)
}

/**
 * Create a signed session token. Payload is JSON with expiry.
 * @param value - arbitrary string to embed, or object to be JSON-stringified; for auth we use SessionPayload
 * @param secret - HMAC secret (APP_SECRET or APP_PASSPHRASE fallback)
 * @param maxAgeMs - optional expiry offset (default 7 days)
 */
export function signSession(value: string, secret: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("signSession: value must be non-empty string");
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("signSession: secret must be non-empty string");
  }
  const payloadB64 = b64UrlEncode(value);
  const sig = hmacSha256Base64Url(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

/**
 * Create a session token with expiry JSON payload.
 * Convenience wrapper around signSession for the auth flow.
 */
export function createSessionToken(secret: string, maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): string {
  if (!secret) throw new Error("createSessionToken: secret required");
  const now = Date.now();
  const payload: SessionPayload = {
    v: 1,
    exp: now + maxAgeMs,
    iat: now,
    nonce: randomBytes(8).toString("hex"),
  };
  const value = JSON.stringify(payload);
  return signSession(value, secret);
}

/**
 * Verify a session token. Checks HMAC signature with timingSafeEqual and expiry.
 * Returns true if valid and not expired, false otherwise.
 * Supports both JSON payload tokens (with exp) and legacy plain-string tokens.
 */
export function verifySession(token: string, secret: string): boolean {
  if (typeof token !== "string" || token.trim().length === 0) return false;
  if (typeof secret !== "string" || secret.length === 0) return false;

  const parts = token.trim().split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return false;

  // Recompute expected signature
  let expectedSig: string;
  try {
    expectedSig = hmacSha256Base64Url(payloadB64, secret);
  } catch {
    return false;
  }

  // Constant-time signature compare
  if (!timingSafeCompare(sigB64, expectedSig)) return false;

  // Decode payload and check expiry if present
  try {
    const payloadStr = b64UrlDecode(payloadB64);
    // Try JSON parse — if fails, it's a legacy plain string token, treat as valid if sig matched
    try {
      const payload = JSON.parse(payloadStr) as SessionPayload & Record<string, unknown>;
      if (payload && typeof payload.exp === "number") {
        if (Date.now() > payload.exp) return false; // expired
        // Optional: check iat not in future (clock skew tolerance 5min)
        if (typeof payload.iat === "number" && payload.iat > Date.now() + 5 * 60 * 1000) return false;
      }
      // v check if present
      if (payload && payload.v !== undefined && payload.v !== 1) {
        // unknown version — still allow if sig valid? Be strict: reject unknown version
        // But for forward compat, we allow only v1
        return false;
      }
    } catch {
      // payload is not JSON — plain string token, no expiry check beyond sig
      // e.g., legacy "authenticated" value — valid if sig matched
    }
  } catch {
    // base64url decode failed — invalid token
    return false;
  }

  return true;
}

/**
 * Verify session and return decoded payload if valid.
 * Useful for debugging; returns { valid, payload, expired }
 */
export function verifySessionWithPayload(
  token: string,
  secret: string
): { valid: boolean; payload?: SessionPayload | string; expired?: boolean } {
  if (!verifySession(token, secret)) {
    // Try to detect expiry vs invalid sig for logging (without leaking to client)
    try {
      const payloadB64 = token.split(".")[0];
      const payloadStr = b64UrlDecode(payloadB64);
      const payload = JSON.parse(payloadStr) as SessionPayload;
      if (payload && typeof payload.exp === "number" && Date.now() > payload.exp) {
        return { valid: false, payload, expired: true };
      }
    } catch {}
    return { valid: false };
  }
  try {
    const payloadB64 = token.split(".")[0];
    const payloadStr = b64UrlDecode(payloadB64);
    try {
      const payload = JSON.parse(payloadStr) as SessionPayload;
      return { valid: true, payload };
    } catch {
      return { valid: true, payload: payloadStr };
    }
  } catch {
    return { valid: true };
  }
}

// ---------------------------------------------------------------------------
// Cookie options helper
// ---------------------------------------------------------------------------

export interface SessionCookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict" | "lax" | "none";
  maxAge: number; // seconds
  path: string;
}

/**
 * Get secure cookie options for the session cookie.
 * Per spec: httpOnly, Secure in prod, SameSite=Strict, maxAge 7 days, path /
 */
export function getSessionCookieOptions(isProduction?: boolean): SessionCookieOptions {
  const prod = typeof isProduction === "boolean" ? isProduction : process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: prod, // Secure only in production (HTTPS); false in local http dev
    sameSite: "strict" as const, // Strict per arch §3.2 CSRF mitigation
    maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
    path: "/",
  };
}

/**
 * Get cookie options for clearing the session (maxAge 0).
 */
export function getClearSessionCookieOptions(): SessionCookieOptions & { maxAge: number } {
  return {
    ...getSessionCookieOptions(),
    maxAge: 0,
  };
}
