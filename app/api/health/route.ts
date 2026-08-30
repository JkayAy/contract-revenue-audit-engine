import { NextResponse } from "next/server";

// Lightweight liveness endpoint used by the Docker HEALTHCHECK directive
// and by Coolify's deployment health probes. Intentionally avoids touching
// Supabase or Redis so it reflects only whether the Next.js server itself
// is up and able to handle requests; deeper dependency checks would risk
// flapping the healthcheck on transient network issues unrelated to the
// app process.
export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "contract-revenue-audit-engine",
    timestamp: new Date().toISOString(),
  });
}
