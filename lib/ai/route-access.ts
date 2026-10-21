/**
 * Access checks shared by the AI assistant's API routes: the signed-in
 * workspace, and an Instagram account of that workspace connected through
 * Meta (the only provider the assistant supports).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

type Access =
  | { ok: true; workspaceId: string; canManage: boolean; account: { id: string; provider: string } }
  | { ok: false; response: NextResponse };

function fail(status: number, error: string): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ success: false, error }, { status }) };
}

export async function accountAccess(
  accountId: unknown,
  { manage }: { manage: boolean }
): Promise<Access> {
  const context = await getCurrentWorkspaceContext();
  if (!context) return fail(401, "Unauthorized");
  const canManage = canManageWorkspace(context.role);
  if (manage && !canManage) return fail(403, "Only owners and admins can change the AI assistant");
  if (typeof accountId !== "string" || !accountId) return fail(400, "accountId is required");
  const account = await prisma.instagramAccount.findFirst({
    where: { id: accountId, workspaceId: context.workspaceId },
    select: { id: true, provider: true },
  });
  if (!account) return fail(404, "Account not found");
  if (account.provider !== "META") {
    return fail(400, "The AI assistant works with accounts connected through Meta only");
  }
  return { ok: true, workspaceId: context.workspaceId, canManage, account };
}

export { fail as accessError };
