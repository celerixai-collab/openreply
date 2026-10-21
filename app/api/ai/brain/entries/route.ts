import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { accountAccess, accessError } from "@/lib/ai/route-access";
import { BRAIN_LIMITS, KnowledgeEntrySchema, firstIssue } from "@/lib/ai/brain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function withoutAccountId(body: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...body };
  delete rest.accountId;
  return rest;
}

const CreateBody = z.union([
  z.object({ accountId: z.string(), entries: z.array(z.unknown()).min(1).max(BRAIN_LIMITS.entries) }),
  z.object({ accountId: z.string() }).passthrough(),
]);

/** Add one entry, or several at once with { entries: [...] }. */
export async function POST(request: NextRequest) {
  const body = CreateBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return accessError(400, "Invalid request body").response;
  const access = await accountAccess(body.data.accountId, { manage: true });
  if (!access.ok) return access.response;

  const raw =
    "entries" in body.data && Array.isArray(body.data.entries)
      ? body.data.entries
      : [withoutAccountId(body.data as Record<string, unknown>)];
  const parsed = [];
  for (const [index, item] of raw.entries()) {
    const entry = KnowledgeEntrySchema.safeParse(item);
    if (!entry.success) {
      return accessError(400, `Entry ${index + 1}: ${firstIssue(entry.error)}`).response;
    }
    parsed.push(entry.data);
  }

  const where = { instagramAccountId: access.account.id };
  const [count, last] = await Promise.all([
    prisma.aiKnowledgeEntry.count({ where }),
    prisma.aiKnowledgeEntry.findFirst({ where, orderBy: { position: "desc" }, select: { position: true } }),
  ]);
  if (count + parsed.length > BRAIN_LIMITS.entries) {
    return accessError(400, `At most ${BRAIN_LIMITS.entries} knowledge entries`).response;
  }
  const start = (last?.position ?? -1) + 1;
  const created = await prisma.$transaction(
    parsed.map((entry, index) =>
      prisma.aiKnowledgeEntry.create({
        data: {
          workspaceId: access.workspaceId,
          instagramAccountId: access.account.id,
          title: entry.title,
          content: entry.content,
          enabled: entry.enabled ?? true,
          position: entry.position ?? start + index,
        },
        select: { id: true, title: true, content: true, enabled: true, position: true },
      })
    )
  );
  return NextResponse.json({ success: true, data: { entries: created } }, { status: 201 });
}

const PatchBody = KnowledgeEntrySchema.partial().strict();

async function ownedEntry(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return { ok: false as const, response: accessError(400, "id is required").response };
  const entry = await prisma.aiKnowledgeEntry.findUnique({
    where: { id },
    select: { id: true, instagramAccountId: true },
  });
  if (!entry) return { ok: false as const, response: accessError(404, "Entry not found").response };
  const access = await accountAccess(entry.instagramAccountId, { manage: true });
  if (!access.ok) return { ok: false as const, response: access.response };
  return { ok: true as const, entry };
}

export async function PATCH(request: NextRequest) {
  const owned = await ownedEntry(request);
  if (!owned.ok) return owned.response;
  const body = PatchBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return accessError(400, firstIssue(body.error)).response;
  const entry = await prisma.aiKnowledgeEntry.update({
    where: { id: owned.entry.id },
    data: body.data,
    select: { id: true, title: true, content: true, enabled: true, position: true },
  });
  return NextResponse.json({ success: true, data: { entry } });
}

export async function DELETE(request: NextRequest) {
  const owned = await ownedEntry(request);
  if (!owned.ok) return owned.response;
  await prisma.aiKnowledgeEntry.delete({ where: { id: owned.entry.id } });
  return NextResponse.json({ success: true });
}
