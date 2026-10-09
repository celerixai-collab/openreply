import { NextRequest, NextResponse } from "next/server";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";
import { requestDraftSend } from "@/lib/ai/drafts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteProps = { params: Promise<{ id: string }> };

/** Approve a draft (as edited) and queue it for delivery. */
export async function POST(request: NextRequest, { params }: RouteProps) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can send AI replies" },
      { status: 403 }
    );
  }

  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const result = await requestDraftSend({
    workspaceId: context.workspaceId,
    draftId: id,
    text: body?.text,
  });
  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.error, code: result.code, bytes: result.bytes },
      { status: result.httpStatus }
    );
  }
  return NextResponse.json({ success: true, data: { status: result.status } }, { status: 202 });
}
