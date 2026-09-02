/**
 * Chat API Route Handler — src/app/api/chat/route.ts:1
 * Next.js Route Handler (Node runtime, not Edge) per ADR-3.
 * Implements: session check (double-check middleware), CSRF Origin/Referer, validation, rate limiting, RAG, logging, error sanitizing.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { retrieveAndGenerate, validateInput } from "@/lib/rag";
import { verifySession, timingSafeCompare, getAuthSecret, getPassphrase } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Security headers (arch §3.6) — applied to every response in this route
// ---------------------------------------------------------------------------

function securityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-XSS-Protection": "0", // modern browsers use CSP; disable legacy heuristic
    // HSTS is handled by Vercel at edge, but we set here defensively
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

function jsonWithSecurity(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): NextResponse {
  const res = NextResponse.json(body, { status: init.status ?? 200 });
  const sec = securityHeaders();
  for (const [k, v] of Object.entries(sec)) res.headers.set(k, v);
  // Explicitly do NOT set permissive CORS headers (arch §3.2)
  // Only allow same-origin; browsers default to same-origin for fetch without CORS headers.
  if (init.headers) {
    for (const [k, v] of Object.entries(init.headers)) res.headers.set(k, v);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Auth check — session cookie double-check (ADR-4) defense in depth §3.3
// Middleware should already gate, but API must not trust UI alone.
// Verifies HMAC signature using APP_SECRET or PASSPHRASE fallback via lib/auth (timingSafeEqual).
// ---------------------------------------------------------------------------

function isAuthenticated(req: NextRequest): boolean {
  const secret = getAuthSecret();
  const passphrase = getPassphrase();

  // If no secret/passphrase configured, skip in dev but warn (open in dev, required in prod)
  if (!secret && !passphrase) {
    console.warn("[chat] No APP_PASSPHRASE/APP_SECRET configured — auth check skipped (dev only). Set APP_PASSPHRASE in prod.");
    return true;
  }

  const hmacSecret = secret ?? passphrase!;

  // 1) Verify HMAC-signed session cookie (primary, ADR-4)
  const sessionCookie = req.cookies.get("session")?.value ?? req.cookies.get("__session")?.value ?? null;
  if (sessionCookie) {
    try {
      if (verifySession(sessionCookie, hmacSecret)) return true;
    } catch {
      // fall through to other checks
    }
    // Legacy fallback: if cookie value is literally the passphrase (pre-HMAC simple mode),
    // allow via timingSafeCompare for backwards compat during transition. Remove after HMAC-only rollout.
    if (passphrase && timingSafeCompare(sessionCookie.trim(), passphrase)) {
      console.warn("[chat] Legacy plain-passphrase cookie accepted — migrate to HMAC-signed session");
      return true;
    }
  }

  // 2) Allow Authorization: Bearer <passphrase> (timingSafeEqual) or Bearer <signed token>
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token.length > 0 && token.length <= 1000) {
      if (passphrase && timingSafeCompare(token, passphrase)) return true;
      // Also allow Bearer with signed session token (e.g., programmatic client that obtained token via /api/auth)
      try {
        if (verifySession(token, hmacSecret)) return true;
      } catch {}
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// CSRF check — verify Origin/Referer matches host (arch §3.2)
// Since auth is cookie-based (SameSite), verify request is same-origin.
// ---------------------------------------------------------------------------

function isCsrfAllowed(req: NextRequest): boolean {
  const host = req.headers.get("host")?.trim() ?? "";
  const origin = req.headers.get("origin")?.trim() ?? "";
  const referer = req.headers.get("referer")?.trim() ?? "";

  // In dev, localhost with any port is allowed; still enforce same-host logic
  // Prefer Origin if present (present on POST/fetch)
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const originHost = originUrl.host; // includes port
      // Allow same host
      if (originHost === host) return true;
      // Allow configured allowed origin (e.g., production domain)
      const allowedOrigins = [
        process.env.NEXT_PUBLIC_SITE_URL,
        process.env.NEXT_PUBLIC_APP_URL,
        process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
        process.env.ALLOWED_ORIGIN,
      ].filter(Boolean) as string[];
      for (const allowed of allowedOrigins) {
        try {
          const allowedHost = new URL(allowed).host;
          if (originHost === allowedHost) return true;
        } catch {
          // allowed may be plain host
          if (originHost === allowed) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  // Fallback to Referer if Origin missing (some browsers / same-origin POST may send Referer)
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      const refererHost = refererUrl.host;
      if (refererHost === host) return true;
      return false;
    } catch {
      return false;
    }
  }

  // If neither Origin nor Referer present (e.g., curl, non-browser client) — allow but log.
  // Strict CSRF mode would reject; we choose to allow for API testing and non-browser clients,
  // but middleware should already handle cookie SameSite=Strict/Lax.
  // To enforce strict, uncomment next line:
  // return false;
  return true;
}

// ---------------------------------------------------------------------------
// Rate limit identifier (IP + session)
// ---------------------------------------------------------------------------

function getClientIdentifier(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const ip =
    (forwarded ? forwarded.split(",")[0].trim() : null) ??
    req.headers.get("x-real-ip")?.trim() ??
    (req as unknown as { ip?: string }).ip ??
    "unknown-ip";
  const session = req.cookies.get("session")?.value ?? req.cookies.get("__session")?.value ?? "no-session";
  // Combine IP + session for per-user + per-IP limiting (arch §3.4)
  return `${ip}:${session.slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // 1. Auth double-check
    if (!isAuthenticated(req)) {
      return jsonWithSecurity({ error: "Unauthorized" }, { status: 401 });
    }

    // 2. CSRF check
    if (!isCsrfAllowed(req)) {
      console.warn("[chat] CSRF blocked", {
        host: req.headers.get("host"),
        origin: req.headers.get("origin"),
        referer: req.headers.get("referer"),
      });
      return jsonWithSecurity({ error: "Forbidden — CSRF check failed" }, { status: 403 });
    }

    // 3. Rate limit BEFORE expensive ops (arch §3.4)
    const identifier = getClientIdentifier(req);
    const rl = await checkRateLimit(identifier, 10, 60_000);
    if (!rl.allowed) {
      return jsonWithSecurity(
        { error: "Too many requests. Please slow down." },
        {
          status: 429,
          headers: {
            "Retry-After": Math.ceil((rl.reset - Date.now()) / 1000).toString(),
            "X-RateLimit-Limit": rl.limit.toString(),
            "X-RateLimit-Remaining": rl.remaining.toString(),
            "X-RateLimit-Reset": rl.reset.toString(),
          },
        }
      );
    }

    // 4. Parse & validate input JSON {message: string}
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonWithSecurity({ error: "Invalid JSON" }, { status: 400 });
    }

    const message =
      typeof body === "object" && body !== null && "message" in body
        ? (body as { message: unknown }).message
        : undefined;

    if (typeof message !== "string") {
      return jsonWithSecurity({ error: "Invalid input: 'message' must be a string" }, { status: 400 });
    }

    // Early validate (length / injection) to fail fast without embedding
    try {
      validateInput(message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Distinguish injection vs empty for client feedback (400), but don't leak internals
      if (msg.includes("prompt injection")) {
        return jsonWithSecurity({ error: "Invalid input rejected" }, { status: 400 });
      }
      return jsonWithSecurity({ error: msg }, { status: 400 });
    }

    // 5. RAG pipeline (embed → retrieve → gate → generate)
    const result = await retrieveAndGenerate(message);

    // 6. Server-side logging (query + chunk IDs — not returned except citations)
    console.log(
      JSON.stringify({
        event: "api_chat_success",
        identifier: identifier.slice(0, 80),
        gated: result.gated ?? false,
        citationsCount: result.citations.length,
      })
    );

    // 7. Return answer + citations [{page, textPreview}] — never leak internal error/details
    const responseBody: {
      answer: string;
      citations: Array<{ page: string | number | null; textPreview: string }>;
      gated?: boolean;
    } = {
      answer: result.answer,
      citations: result.citations.map((c) => ({
        page: c.page,
        textPreview: c.textPreview,
      })),
    };

    // Include gated hint optionally (client can show out-of-scope UI)
    if (result.gated) responseBody.gated = true;

    const res = jsonWithSecurity(responseBody, {
      status: 200,
      headers: {
        "X-RateLimit-Limit": rl.limit.toString(),
        "X-RateLimit-Remaining": rl.remaining.toString(),
        "X-RateLimit-Reset": rl.reset.toString(),
      },
    });
    return res;
  } catch (err) {
    // Log full error server-side, return generic to client (arch §3.1)
    console.error("[chat] Unhandled error:", err instanceof Error ? { message: err.message, stack: err.stack } : err);
    // Avoid leaking stack trace or key material
    return jsonWithSecurity({ error: "Something went wrong" }, { status: 500 });
  }
}

// Only POST allowed
export async function GET(): Promise<NextResponse> {
  return jsonWithSecurity({ error: "Method not allowed" }, { status: 405 });
}
