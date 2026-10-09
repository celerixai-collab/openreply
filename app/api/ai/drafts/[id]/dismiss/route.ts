import { NextRequest, NextResponse } from "next/server";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";
import { dismissDraft } from "@/lib/ai/drafts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteProps = { params: Promise<{ id: string }> };

/** "Don't reply": the draft is closed without sending anything. */
export async function POST(_request: NextRequest, { params }: RouteProps) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can dismiss AI drafts" },
      { status: 403 }
    );
  }

  const { id } = await params;
  const dismissed = await dismissDraft({ workspaceId: context.workspaceId, draftId: id });
  if (!dismissed) {
    return NextResponse.json(
      { success: false, error: "Draft not found or already decided" },
      { status: 409 }
    );
  }
  return NextResponse.json({ success: true, data: { status: "DISMISSED" } });
}
