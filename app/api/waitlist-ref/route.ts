import { NextRequest, NextResponse } from "next/server";
import { parseRecipientToken } from "@/lib/tracking/server";
import { WAITLIST_ORIGINS, resolveWaitlistRef } from "@/lib/tracking/waitlist-ref";

/**
 * Public, for the waitlist page only: who a waitlist link was sent to.
 * GET ?s=<link slug>&r=<recipient token, optional> → { campaign, username|null } or 404.
 */
function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = { "Cache-Control": "no-store", Vary: "Origin" };
  if (origin && WAITLIST_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET";
  }
  return headers;
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request: NextRequest) {
  const headers = corsHeaders(request);
  const slug = request.nextUrl.searchParams.get("s") ?? "";
  const token = parseRecipientToken(request.nextUrl.searchParams.get("r"));
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(slug)) {
    return NextResponse.json({ ok: false }, { status: 400, headers });
  }

  const ref = await resolveWaitlistRef(slug, token);
  if (!ref) return NextResponse.json({ ok: false }, { status: 404, headers });
  return NextResponse.json({ ok: true, ...ref }, { headers });
}
