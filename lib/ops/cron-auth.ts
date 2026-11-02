import type { NextRequest } from "next/server";

// A refusal used to leave no trace, so the daily jobs could answer 401 for months
// without anyone knowing. Lengths say what is wrong without saying the secret.
export function isCronRequest(request: NextRequest): boolean {
  const secret = (process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET)?.trim();
  const header = request.headers.get("authorization")?.trim();
  if (secret && header === `Bearer ${secret}`) return true;
  console.warn("[Cron] Refused", {
    path: request.nextUrl.pathname,
    userAgent: request.headers.get("user-agent"),
    headerLength: header?.length ?? 0,
    expectedLength: secret ? `Bearer ${secret}`.length : 0,
  });
  return false;
}
