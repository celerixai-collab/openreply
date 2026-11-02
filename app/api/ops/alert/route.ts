import { NextRequest, NextResponse } from "next/server";
import { alertSubject, emailWorkspaceOwner } from "@/lib/ops/alert-email";
import type { SystemIssue } from "@/lib/ops/system-check";

export const runtime = "nodejs";

// The worker's way to mail: the mail key lives only on the web app.
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    ping?: boolean;
    workspaceId?: string;
    issues?: SystemIssue[];
  };
  if (body.ping) return NextResponse.json({ success: true });
  if (!body.workspaceId || !body.issues?.length) {
    return NextResponse.json({ success: false, error: "Nothing to send" }, { status: 400 });
  }

  await emailWorkspaceOwner(body.workspaceId, alertSubject(body.issues), body.issues);
  return NextResponse.json({ success: true });
}
