/**
 * Health check — src/app/api/health/route.ts:1
 * Simple liveness probe for Vercel / uptime monitors (arch §ADR-5).
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const startedAt = (globalThis as unknown as { __healthStartedAt?: number }).__healthStartedAt;
  if (!(globalThis as unknown as { __healthStartedAt?: number }).__healthStartedAt) {
    (globalThis as unknown as { __healthStartedAt: number }).__healthStartedAt = Date.now();
  }
  const uptimeMs = Date.now() - ((startedAt ?? Date.now()));

  return NextResponse.json(
    {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptimeMs,
      version: process.env.npm_package_version ?? "0.1.0",
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    }
  );
}
