import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { requeueExpiredTokenComments } from "@/lib/queue/requeue-throttled";

export const runtime = "nodejs";

export async function POST() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const requeued = await requeueExpiredTokenComments(workspaceId);
  return NextResponse.json({ success: true, data: { requeued } });
}
