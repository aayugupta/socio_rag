/**
 * Middleware — src/middleware.ts:1
 * ADR-4 shared-passphrase gate + security headers + rate limiting.
 * Runs on Vercel Edge Middleware (Web Crypto). Token format compatible with src/lib/auth.ts (Node crypto).
 *
 * - Checks session cookie `session` (httpOnly, HMAC-signed). If missing/invalid, redirect to /login (pages) or 401 JSON (api).
 * - Verifies HMAC using APP_SECRET or APP_PASSPHRASE fallback via Web Crypto subtle.
 * - Applies security headers to all responses: CSP, HSTS, X-Content-Type-Options, Referrer-Policy, X-Frame-Options, etc.
 * - Basic per-IP rate limiting before expensive calls (in-memory, Edge-compatible).
 * - Matcher excludes static assets and /api/health for uptime checks per ADR-5.
 * - SameSite=Strict enforced at cookie creation time (auth route).
 */

import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Security headers — arch §3.6
// Applied to every response via middleware; next.config.ts provides backup.
// ---------------------------------------------------------------------------

const CSP_VALUE = [
  "default-src 'self'",
  // Next.js requires unsafe-inline/unsafe-eval for hydration; restrict otherwise
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://api.openai.com https://*.trychroma.com https://*.upstash.io",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP_VALUE,
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-XSS-Protection": "0", // disable legacy heuristic, rely on CSP
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function applySecurityHeaders(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(k, v);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Env / secret helper
// ---------------------------------------------------------------------------

function getAuthSecret(): string | undefined {
  const s =
    process.env.APP_SECRET?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    undefined;
  if (s) return s;
  const p =
    process.env.APP_PASSPHRASE?.trim() ||
    process.env.PASSPHRASE?.trim() ||
    process.env.RAG_PASSPHRASE?.trim() ||
    undefined;
  return p;
}

// ---------------------------------------------------------------------------
// Base64url helpers (Edge-compatible, no Buffer)
// ---------------------------------------------------------------------------

function base64UrlDecodeToString(b64url: string): string {
  // base64url -> base64 -> binary string -> TextDecoder
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function bytesToBase64Url(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// ---------------------------------------------------------------------------
// HMAC + constant-time compare (Web Crypto, Edge-compatible)
// ---------------------------------------------------------------------------

async function hmacSha256Base64Url(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToBase64Url(new Uint8Array(sig));
}

function constantTimeEqual(a: string, b: string): boolean {
  // Constant-time charCode loop (Edge-safe, no Node timingSafeEqual)
  const aLen = a.length;
  const bLen = b.length;
  const maxLen = Math.max(aLen, bLen);
  let diff = aLen ^ bLen;
  for (let i = 0; i < maxLen; i++) {
    const ca = i < aLen ? a.charCodeAt(i) : 0;
    const cb = i < bLen ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

async function verifySessionEdge(token: string, secret: string): Promise<boolean> {
  if (!token || !secret) return false;
  const trimmed = token.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return false;

  let expectedSig: string;
  try {
    expectedSig = await hmacSha256Base64Url(payloadB64, secret);
  } catch {
    return false;
  }

  if (!constantTimeEqual(sigB64, expectedSig)) return false;

  // Decode payload and check expiry
  try {
    const payloadStr = base64UrlDecodeToString(payloadB64);
    try {
      const payload = JSON.parse(payloadStr) as { exp?: number; iat?: number; v?: number };
      if (payload && typeof payload.exp === "number") {
        if (Date.now() > payload.exp) return false;
        if (typeof payload.iat === "number" && payload.iat > Date.now() + 5 * 60 * 1000) return false;
      }
      if (payload && payload.v !== undefined && payload.v !== 1) return false;
    } catch {
      // plain string payload — no expiry check
    }
  } catch {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Per-IP rate limiting (Edge in-memory, globalThis)
// ---------------------------------------------------------------------------

type RateEntry = { count: number; resetAt: number };

function getRateStore(): Map<string, RateEntry> {
  const g = globalThis as unknown as { __mwRateLimit?: Map<string, RateEntry> };
  if (!g.__mwRateLimit) g.__mwRateLimit = new Map<string, RateEntry>();
  return g.__mwRateLimit;
}

function checkRateLimitMemory(
  identifier: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number; reset: number; limit: number } {
  const store = getRateStore();
  const now = Date.now();
  const entry = store.get(identifier);

  // Periodic cleanup (10% chance)
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

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  // NextRequest `ip` is available in some Vercel contexts as geo
  const maybeIp = (req as unknown as { ip?: string }).ip;
  if (maybeIp) return maybeIp;
  return "unknown-ip";
}

// ---------------------------------------------------------------------------
// Middleware main
// ---------------------------------------------------------------------------

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const pathname = req.nextUrl.pathname;

  // --- Security headers will be applied to every response via helper ---

  // Public paths that do not require auth: /login, /api/auth*, /api/health already excluded via matcher
  // but keep defense in depth for direct matcher bypass
  const isPublicPath =
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname.startsWith("/api/auth");

  // Health explicitly excluded per ADR-5 (uptime checks must not require auth)
  if (pathname === "/api/health" || pathname.startsWith("/api/health/")) {
    return applySecurityHeaders(NextResponse.next());
  }

  // Static asset bypass (matcher should already exclude, but handle for safety)
  if (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    /\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?|ttf|eot|map|txt|xml)$/i.test(pathname)
  ) {
    return applySecurityHeaders(NextResponse.next());
  }

  // --- Per-IP rate limiting BEFORE expensive calls / auth (arch §3.4) ---
  // Middleware-level: 30 req / 60s per IP. api/chat has stricter 10/60s via Redis/in-memory.
  // Login endpoint gets tighter limit to prevent brute force: 10 / 60s
  const ip = getClientIp(req);
  const isLoginAttempt = pathname.startsWith("/api/auth");
  const mwLimit = isLoginAttempt ? 10 : 30;
  const mwWindowMs = 60_000;
  const rl = checkRateLimitMemory(`mw:${ip}:${isLoginAttempt ? "auth" : "gen"}`, mwLimit, mwWindowMs);

  if (!rl.allowed) {
    const retryAfter = Math.ceil((rl.reset - Date.now()) / 1000).toString();
    if (pathname.startsWith("/api/")) {
      const res = NextResponse.json(
        { error: "Too many requests. Please slow down." },
        {
          status: 429,
          headers: {
            "Retry-After": retryAfter,
            "X-RateLimit-Limit": rl.limit.toString(),
            "X-RateLimit-Remaining": rl.remaining.toString(),
            "X-RateLimit-Reset": rl.reset.toString(),
          },
        }
      );
      return applySecurityHeaders(res);
    } else {
      const res = new NextResponse("Too Many Requests - please slow down", {
        status: 429,
        headers: {
          "Retry-After": retryAfter,
          "X-RateLimit-Limit": rl.limit.toString(),
          "X-RateLimit-Remaining": rl.remaining.toString(),
          "X-RateLimit-Reset": rl.reset.toString(),
        },
      });
      return applySecurityHeaders(res);
    }
  }

  // --- Auth gate (ADR-4) ---
  // If public path, allow through without session check
  if (isPublicPath) {
    return applySecurityHeaders(NextResponse.next());
  }

  const secret = getAuthSecret();
  // No secret configured → bypass in dev but warn (spec: open in dev, required in prod)
  if (!secret) {
    console.warn("[middleware] No APP_SECRET/APP_PASSPHRASE configured — auth gate bypassed (dev only). Set APP_PASSPHRASE in production.");
    return applySecurityHeaders(NextResponse.next());
  }

  const sessionCookie =
    req.cookies.get("session")?.value ?? req.cookies.get("__session")?.value ?? null;

  let authenticated = false;
  if (sessionCookie) {
    try {
      authenticated = await verifySessionEdge(sessionCookie, secret);
    } catch (err) {
      console.warn("[middleware] session verification error", err);
      authenticated = false;
    }
  }

  if (!authenticated) {
    // Not authenticated → redirect for pages, 401 JSON for API routes (arch §3.3 defense in depth)
    if (pathname.startsWith("/api/")) {
      const res = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      return applySecurityHeaders(res);
    } else {
      const loginUrl = new URL("/login", req.url);
      // Preserve attempted path for post-login redirect
      if (pathname !== "/" && pathname !== "/login") {
        loginUrl.searchParams.set("next", pathname + req.nextUrl.search);
      }
      const res = NextResponse.redirect(loginUrl);
      return applySecurityHeaders(res);
    }
  }

  // Authenticated — proceed and attach rate limit headers + security headers
  const res = NextResponse.next();
  res.headers.set("X-RateLimit-Limit", rl.limit.toString());
  res.headers.set("X-RateLimit-Remaining", rl.remaining.toString());
  res.headers.set("X-RateLimit-Reset", rl.reset.toString());
  return applySecurityHeaders(res);
}

// ---------------------------------------------------------------------------
// Matcher — run on all routes except static assets and /api/health (ADR-5)
// ---------------------------------------------------------------------------

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - api/health (uptime probe, must be public per ADR-5)
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, and common static asset extensions
     * This is the recommended Next.js matcher pattern with an added negative lookahead for api/health.
     */
    "/((?!api/health|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff|woff2|ttf|eot|map|txt|xml)$).*)",
  ],
};
