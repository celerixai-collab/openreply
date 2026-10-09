import { NextRequest, NextResponse } from "next/server";
import {
  importCommenters,
  type ImportCursor,
} from "@/lib/contacts/import-comments";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One slice of "import everyone who commented on our posts". The Contacts
// page calls it repeatedly with the returned cursor until the cursor is null.
export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can import contacts" },
      { status: 403 },
    );
  }
  const body = await request.json().catch(() => ({}));
  const cursor = (body?.cursor ?? null) as ImportCursor | null;
  try {
    const result = await importCommenters(context.workspaceId, cursor);
    return NextResponse.json(
      { success: true, data: result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Import failed",
      },
      { status: 502 },
    );
  }
}
