import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";
import {
  createInstagramContext,
  hasInstagramCredentials,
} from "@/lib/instagram/context";
import { sendDirectMessageWithLinkButton } from "@/lib/instagram/send-messages";
import { isInstagramThrottle } from "@/lib/instagram/delivery-errors";
import { getRedisConnection } from "@/lib/queue/client";

/**
 * One-off launch announcement: one DM to everyone who ever commented on a
 * "剪輯室 早鳥等候 A–F" campaign. Owners and admins only. Each person is sent
 * at most once (a Redis set remembers who got it), a call sends at most
 * `limit` people, and it stops early when Instagram starts throttling.
 */
const CAMPAIGN_NAME = /^剪輯室 早鳥等候 [A-F]$/;
const SENT_KEY = "launch-blast:2026-10-28:sent";
// People Instagram refused because their last interaction is too old; skipped from now on.
const CLOSED_KEY = "launch-blast:2026-10-28:closed";

const bodySchema = z.object({
  text: z.string().min(1).max(600),
  buttonTitle: z.string().min(1).max(20),
  url: z.string().url(),
  limit: z.number().int().min(1).max(25).default(10),
  dryRun: z.boolean().default(false),
  // Send only to these Instagram usernames (test sends).
  usernames: z.array(z.string().min(1)).max(25).optional(),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context || !canManageWorkspace(context.role)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { text, buttonTitle, url, limit, dryRun, usernames } = parsed.data;
  const workspaceId = context.workspaceId;

  const campaigns = (
    await prisma.automation.findMany({
      where: { workspaceId },
      include: { instagramAccount: true },
    })
  ).filter((c) => CAMPAIGN_NAME.test(c.name));
  if (campaigns.length === 0) {
    return NextResponse.json({ success: false, error: "No A–F campaigns found" }, { status: 404 });
  }
  const accountById = new Map(campaigns.map((c) => [c.instagramAccountId, c.instagramAccount]));

  // One row per person per account, the most recent comment first.
  const people = await prisma.dmLog.findMany({
    where: { automationId: { in: campaigns.map((c) => c.id) } },
    distinct: ["instagramAccountId", "commenterId"],
    orderBy: { createdAt: "desc" },
    select: {
      instagramAccountId: true,
      commenterId: true,
      commenterName: true,
      createdAt: true,
    },
  });

  const redis = getRedisConnection();
  const alreadySent = new Set(await redis.smembers(SENT_KEY));
  const closed = new Set(await redis.smembers(CLOSED_KEY));

  let targetIgsids: Set<string> | null = null;
  if (usernames?.length) {
    const wanted = usernames.map((u) => u.replace(/^@/, "").toLowerCase());
    const contacts = await prisma.contact.findMany({
      where: { workspaceId, username: { in: wanted, mode: "insensitive" } },
      select: { igsid: true },
    });
    targetIgsids = new Set(contacts.map((c) => c.igsid));
    for (const p of people) {
      if (p.commenterName && wanted.includes(p.commenterName.replace(/^@/, "").toLowerCase())) {
        targetIgsids.add(p.commenterId);
      }
    }
  }

  const pending = people.filter(
    (p) =>
      !alreadySent.has(p.commenterId) &&
      (!closed.has(p.commenterId) || Boolean(usernames?.length)) &&
      (!targetIgsids || targetIgsids.has(p.commenterId))
  );
  const batch = pending.slice(0, limit);

  const summary = {
    campaigns: campaigns.length,
    uniquePeople: people.length,
    alreadySent: alreadySent.size,
    closed: closed.size,
    pendingBefore: pending.length,
  };
  if (dryRun) {
    return NextResponse.json({
      success: true,
      data: { ...summary, wouldSend: batch.map((p) => p.commenterName ?? p.commenterId) },
    });
  }

  const sent: string[] = [];
  const failed: { user: string; error: string }[] = [];
  let throttled = 0;
  for (const person of batch) {
    const label = person.commenterName ?? person.commenterId;
    const account = accountById.get(person.instagramAccountId);
    if (!account || !hasInstagramCredentials(account)) {
      failed.push({ user: label, error: "account has no credentials" });
      continue;
    }
    try {
      const igContext = await createInstagramContext(account, `launch-blast:${person.commenterId}`);
      await sendDirectMessageWithLinkButton({
        context: igContext,
        instagramAccountId: account.instagramId,
        userId: person.commenterId,
        text,
        buttons: [{ title: buttonTitle, url }],
      });
      await redis.sadd(SENT_KEY, person.commenterId);
      sent.push(label);
      throttled = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ user: label, error: message.slice(0, 200) });
      if (/outside of allowed window|sub=2534022/i.test(message)) {
        await redis.sadd(CLOSED_KEY, person.commenterId);
      }
      if (isInstagramThrottle(error) && ++throttled >= 3) break;
    }
    await sleep(1500);
  }

  return NextResponse.json({
    success: true,
    data: { ...summary, sent, failed, stoppedEarly: throttled >= 3 },
  });
}
