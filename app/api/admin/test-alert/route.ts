import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { emailWorkspaceOwner } from "@/lib/ops/alert-email";

export const runtime = "nodejs";

// Sends the owner a test of the problem mail.
export async function POST() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    await emailWorkspaceOwner(workspaceId, "OpenReply 警報測試", [
      { id: "test", title: "這是測試信", detail: "收到這封，代表系統出問題時可以通知到你。" },
    ]);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
