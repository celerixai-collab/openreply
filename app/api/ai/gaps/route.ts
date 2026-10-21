import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { accountAccess } from "@/lib/ai/route-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Questions the assistant could not answer from its knowledge, most asked
 * first: what to add to the second brain next.
 */
export async function GET(request: NextRequest) {
  const access = await accountAccess(request.nextUrl.searchParams.get("accountId"), {
    manage: false,
  });
  if (!access.ok) return access.response;
  const rows = await prisma.aiDraft.findMany({
    where: {
      instagramAccountId: access.account.id,
      knowledgeGap: true,
      createdAt: { gte: new Date(Date.now() - WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { gapQuestion: true, inboundText: true, createdAt: true, username: true },
  });
  const groups = new Map<
    string,
    { question: string; count: number; lastAskedAt: Date; example: string; usernames: string[] }
  >();
  for (const row of rows) {
    const question = (row.gapQuestion || row.inboundText).trim().slice(0, 200);
    const keyText = question.normalize("NFKC").replace(/[\s？?。！!，,]/g, "").toLowerCase();
    const group = groups.get(keyText);
    if (group) {
      group.count += 1;
      if (row.username && group.usernames.length < 5 && !group.usernames.includes(row.username)) {
        group.usernames.push(row.username);
      }
    } else {
      groups.set(keyText, {
        question,
        count: 1,
        lastAskedAt: row.createdAt,
        example: row.inboundText.slice(0, 300),
        usernames: row.username ? [row.username] : [],
      });
    }
  }
  const gaps = [...groups.values()].sort(
    (a, b) => b.count - a.count || b.lastAskedAt.getTime() - a.lastAskedAt.getTime()
  );
  return NextResponse.json(
    { success: true, data: { gaps: gaps.slice(0, 50) } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
