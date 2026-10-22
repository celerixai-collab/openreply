import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { checkWaitlistTaps } from "@/lib/tracking/waitlist-ref";

export const runtime = "nodejs";

/** GET ?hours=48: recent waitlist link taps and whether each was matched to its person. */
export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const hours = Math.min(Math.max(Number(request.nextUrl.searchParams.get("hours")) || 48, 1), 24 * 14);
  const data = await checkWaitlistTaps(workspaceId, new Date(Date.now() - hours * 3600_000));
  return NextResponse.json({ success: true, data }, { headers: { "Cache-Control": "no-store" } });
}
