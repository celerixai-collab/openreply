import { NextResponse } from "next/server";
import { backfillContactsFromDmLogs } from "@/lib/contacts/backfill";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

// Adds everyone the workspace's campaigns replied to before contacts were
// recorded. Idempotent; the Contacts page calls it once per browser session.
export async function POST() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can import contacts" },
      { status: 403 }
    );
  }
  const result = await backfillContactsFromDmLogs(context.workspaceId);
  return NextResponse.json(
    { success: true, data: result },
    { headers: { "Cache-Control": "no-store" } }
  );
}
