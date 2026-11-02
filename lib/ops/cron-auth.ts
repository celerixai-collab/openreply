import type { NextRequest } from "next/server";

// A refusal used to leave no trace, so Vercel's daily calls could answer 401 for
// two months without anyone knowing.
export function isCronRequest(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;
  const header = request.headers.get("authorization");
  if (secret && header === `Bearer ${secret}`) return true;
  console.warn("[Cron] Refused", {
    path: request.nextUrl.pathname,
    userAgent: request.headers.get("user-agent"),
    sentSecret: Boolean(header),
  });
  return false;
}
