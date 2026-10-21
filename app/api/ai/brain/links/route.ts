import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { accountAccess, accessError } from "@/lib/ai/route-access";
import { BRAIN_LIMITS, LinkSchema, firstIssue } from "@/lib/ai/brain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function withoutAccountId(body: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...body };
  delete rest.accountId;
  return rest;
}

const CreateBody = z.union([
  z.object({ accountId: z.string(), links: z.array(z.unknown()).min(1).max(BRAIN_LIMITS.links) }),
  z.object({ accountId: z.string() }).passthrough(),
]);

/** Add one link, or several at once with { links: [...] }. */
export async function POST(request: NextRequest) {
  const body = CreateBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return accessError(400, "Invalid request body").response;
  const access = await accountAccess(body.data.accountId, { manage: true });
  if (!access.ok) return access.response;

  const raw =
    "links" in body.data && Array.isArray(body.data.links)
      ? body.data.links
      : [withoutAccountId(body.data as Record<string, unknown>)];
  const parsed = [];
  for (const [index, item] of raw.entries()) {
    const entry = LinkSchema.safeParse(item);
    if (!entry.success) {
      return accessError(400, `Link ${index + 1}: ${firstIssue(entry.error)}`).response;
    }
    parsed.push(entry.data);
  }

  const where = { instagramAccountId: access.account.id };
  const [count, last] = await Promise.all([
    prisma.aiLink.count({ where }),
    prisma.aiLink.findFirst({ where, orderBy: { position: "desc" }, select: { position: true } }),
  ]);
  if (count + parsed.length > BRAIN_LIMITS.links) {
    return accessError(400, `At most ${BRAIN_LIMITS.links} links`).response;
  }
  const start = (last?.position ?? -1) + 1;
  const created = await prisma.$transaction(
    parsed.map((entry, index) =>
      prisma.aiLink.create({
        data: {
          workspaceId: access.workspaceId,
          instagramAccountId: access.account.id,
          label: entry.label,
          url: entry.url,
          description: entry.description ?? "",
          enabled: entry.enabled ?? true,
          position: entry.position ?? start + index,
        },
        select: { id: true, label: true, url: true, description: true, enabled: true, position: true },
      })
    )
  );
  return NextResponse.json({ success: true, data: { links: created } }, { status: 201 });
}

const PatchBody = LinkSchema.partial().strict();

async function ownedLink(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return { ok: false as const, response: accessError(400, "id is required").response };
  const entry = await prisma.aiLink.findUnique({
    where: { id },
    select: { id: true, instagramAccountId: true },
  });
  if (!entry) return { ok: false as const, response: accessError(404, "Link not found").response };
  const access = await accountAccess(entry.instagramAccountId, { manage: true });
  if (!access.ok) return { ok: false as const, response: access.response };
  return { ok: true as const, link: entry };
}

export async function PATCH(request: NextRequest) {
  const owned = await ownedLink(request);
  if (!owned.ok) return owned.response;
  const body = PatchBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return accessError(400, firstIssue(body.error)).response;
  const entry = await prisma.aiLink.update({
    where: { id: owned.link.id },
    data: body.data,
    select: { id: true, label: true, url: true, description: true, enabled: true, position: true },
  });
  return NextResponse.json({ success: true, data: { link: entry } });
}

export async function DELETE(request: NextRequest) {
  const owned = await ownedLink(request);
  if (!owned.ok) return owned.response;
  await prisma.aiLink.delete({ where: { id: owned.link.id } });
  return NextResponse.json({ success: true });
}
