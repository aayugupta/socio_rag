/**
 * Auth logout alias — src/app/api/auth/logout/route.ts:1
 * Supports POST or DELETE to /api/auth/logout to clear session cookie.
 * This is an alias for DELETE /api/auth per spec: "Also support DELETE or POST to /api/auth/logout"
 * Keeps CSRF and security headers consistent.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionCookieOptions } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function securityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-XSS-Protection": "0",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

function jsonWithSecurity(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): NextResponse {
  const res = NextResponse.json(body, { status: init.status ?? 200 });
  for (const [k, v] of Object.entries(securityHeaders())) res.headers.set(k, v);
  if (init.headers) for (const [k, v] of Object.entries(init.headers)) res.headers.set(k, v);
  return res;
}

function isCsrfAllowed(req: NextRequest): boolean {
  const host = req.headers.get("host")?.trim() ?? "";
  const origin = req.headers.get("origin")?.trim() ?? "";
  const referer = req.headers.get("referer")?.trim() ?? "";
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost === host) return true;
      const allowed = [
        process.env.NEXT_PUBLIC_SITE_URL,
        process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
        process.env.ALLOWED_ORIGIN,
      ].filter(Boolean) as string[];
      for (const a of allowed) {
        try {
          if (new URL(a as string).host === originHost) return true;
        } catch {
          if (a === originHost) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }
  if (referer) {
    try {
      return new URL(referer).host === host;
    } catch {
      return false;
    }
  }
  return true;
}

function clearCookie(res: NextResponse): void {
  const opts = getSessionCookieOptions();
  res.cookies.set("session", "", {
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    maxAge: 0,
    path: opts.path,
  });
  res.cookies.set("__session", "", {
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    maxAge: 0,
    path: opts.path,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isCsrfAllowed(req)) {
    return jsonWithSecurity({ error: "Forbidden — CSRF check failed" }, { status: 403 });
  }
  const res = jsonWithSecurity({ success: true, message: "Logged out" }, { status: 200 });
  clearCookie(res);
  return res;
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  if (!isCsrfAllowed(req)) {
    return jsonWithSecurity({ error: "Forbidden — CSRF check failed" }, { status: 403 });
  }
  const res = jsonWithSecurity({ success: true, message: "Logged out" }, { status: 200 });
  clearCookie(res);
  return res;
}

export async function GET(): Promise<NextResponse> {
  return jsonWithSecurity({ error: "Method not allowed" }, { status: 405 });
}
