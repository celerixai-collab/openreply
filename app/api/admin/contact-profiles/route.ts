import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { backfillContactProfiles } from "@/lib/contacts/profile";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST { accountId, sinceDays?, batch? }: look up follower counts for recent
 * contacts that have none. Call again while `remaining` is above zero.
 */
export async function POST(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as
    | { accountId?: unknown; sinceDays?: unknown; batch?: unknown }
    | null;
  if (typeof body?.accountId !== "string" || !body.accountId) {
    return NextResponse.json({ success: false, error: "accountId is required" }, { status: 400 });
  }
  const sinceDays = Math.min(Math.max(Number(body.sinceDays) || 7, 1), 30);
  const batch = Math.min(Math.max(Number(body.batch) || 40, 1), 60);
  const data = await backfillContactProfiles({ workspaceId, accountId: body.accountId, sinceDays, batch });
  if (!data) {
    return NextResponse.json({ success: false, error: "Account not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true, data });
}
