import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";
import {
  expireStaleAiDrafts,
  parseDraftQuery,
  latestInboundByPerson,
  peopleWithSentReply,
  personKey,
} from "@/lib/ai/drafts";
import { replyWindowEndsAt } from "@/lib/ai/constants";

// Read-your-writes (a send or dismiss must show at once) and holds DMs.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const query = parseDraftQuery(request.nextUrl.searchParams);
  // Lazily, in addition to the worker's periodic sweep.
  await expireStaleAiDrafts({ workspaceId: context.workspaceId });

  const where = {
    workspaceId: context.workspaceId,
    status: { in: query.statuses },
    ...(query.accountId ? { instagramAccountId: query.accountId } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.aiDraft.findMany({
      where,
      orderBy: [{ createdAt: query.view === "pending" ? "asc" : "desc" }, { id: "asc" }],
      skip: query.skip,
      take: query.limit,
      select: {
        id: true,
        instagramAccountId: true,
        igsid: true,
        username: true,
        inboundText: true,
        inboundAt: true,
        historySnapshot: true,
        draftText: true,
        intent: true,
        needsHuman: true,
        handoffReason: true,
        language: true,
        confidence: true,
        status: true,
        finalText: true,
        error: true,
        createdAt: true,
        decidedAt: true,
        sentAt: true,
        contact: { select: { name: true, username: true } },
        instagramAccount: {
          select: { username: true, aiAssistant: { select: { disclosureText: true } } },
        },
      },
    }),
    prisma.aiDraft.count({ where }),
  ]);

  const people = rows.map((row) => ({
    instagramAccountId: row.instagramAccountId,
    igsid: row.igsid,
  }));
  const [latest, replied] = await Promise.all([
    latestInboundByPerson(people),
    peopleWithSentReply(people),
  ]);

  const drafts = rows.map(({ igsid, instagramAccount, contact, ...row }) => {
    const key = personKey({ instagramAccountId: row.instagramAccountId, igsid });
    const latestInbound = latest.get(key) ?? row.inboundAt;
    return {
      ...row,
      username: row.username ?? contact?.username ?? null,
      name: contact?.name ?? null,
      accountUsername: instagramAccount.username,
      disclosureText: instagramAccount.aiAssistant?.disclosureText ?? "",
      firstReply: !replied.has(key),
      windowEndsAt: replyWindowEndsAt(latestInbound).toISOString(),
    };
  });

  return NextResponse.json(
    {
      success: true,
      data: {
        drafts,
        canManage: canManageWorkspace(context.role),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
