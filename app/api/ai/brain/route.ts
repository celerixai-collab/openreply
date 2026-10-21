import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { accountAccess } from "@/lib/ai/route-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ORDER = [{ position: "asc" as const }, { createdAt: "asc" as const }, { id: "asc" as const }];

/** The account's knowledge entries and links, enabled or not. */
export async function GET(request: NextRequest) {
  const access = await accountAccess(request.nextUrl.searchParams.get("accountId"), {
    manage: false,
  });
  if (!access.ok) return access.response;
  const where = { instagramAccountId: access.account.id };
  const [entries, links] = await Promise.all([
    prisma.aiKnowledgeEntry.findMany({
      where,
      orderBy: ORDER,
      select: { id: true, title: true, content: true, enabled: true, position: true, updatedAt: true },
    }),
    prisma.aiLink.findMany({
      where,
      orderBy: ORDER,
      select: { id: true, label: true, url: true, description: true, enabled: true, position: true },
    }),
  ]);
  return NextResponse.json(
    { success: true, data: { entries, links, canManage: access.canManage } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
