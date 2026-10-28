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
import {
  sendCommentReply,
  sendDirectMessageWithLinkButton,
} from "@/lib/instagram/send-messages";
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
// People whose old comment already got the public nudge (or could not take one).
const REPLIED_KEY = "launch-blast:2026-10-28:replied";

// Positive-emoji public replies, rotated so they do not read as one pasted line.
const REPLY_VARIANTS = [
  "剪輯系統上線了 🎉 早鳥價 $81 只到 11/6，回覆「{kw}」我馬上私訊連結給你 🙌",
  "Leo 剪輯室開賣了 🔥 早鳥價到 11/6，回覆「{kw}」領取購買連結 ✨",
  "等很久了吧 😆 剪輯系統現在上線，早鳥優惠趕快搶，回覆「{kw}」拿連結 👉",
  "好消息 🎊 AI 剪輯系統開賣，早鳥價只到 11/6，回覆「{kw}」我私訊你連結 💛",
];

const bodySchema = z.object({
  // "dm": the announcement DM with a link button. "reply": a public reply under
  // the person's latest comment that asks them to answer with the keyword, which
  // re-opens the messaging window for the campaign's own DM.
  mode: z.enum(["dm", "reply"]).default("dm"),
  text: z.string().max(600).default(""),
  buttonTitle: z.string().max(20).default(""),
  url: z.string().url().optional(),
  limit: z.number().int().min(1).max(40).default(10),
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
  const { mode, text, buttonTitle, url, limit, dryRun, usernames } = parsed.data;
  if (mode === "dm" && (!text || !buttonTitle || !url)) {
    return NextResponse.json({ success: false, error: "dm mode needs text, buttonTitle and url" }, { status: 400 });
  }
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
      commentId: true,
      automationId: true,
    },
  });
  const keywordByAutomation = new Map(campaigns.map((c) => [c.id, c.keywords?.[0] ?? "剪輯"]));

  const redis = getRedisConnection();
  const alreadySent = new Set(await redis.smembers(SENT_KEY));
  const closed = new Set(await redis.smembers(CLOSED_KEY));
  const replied = new Set(await redis.smembers(REPLIED_KEY));

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
      (mode === "reply"
        ? !replied.has(p.commenterId)
        : !closed.has(p.commenterId) || Boolean(usernames?.length)) &&
      (!targetIgsids || targetIgsids.has(p.commenterId))
  );
  const batch = pending.slice(0, limit);

  const summary = {
    campaigns: campaigns.length,
    uniquePeople: people.length,
    alreadySent: alreadySent.size,
    closed: closed.size,
    replied: replied.size,
    mode,
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
  if (mode === "reply") {
    let n = replied.size;
    for (const person of batch) {
      const label = person.commenterName ?? person.commenterId;
      const account = accountById.get(person.instagramAccountId);
      if (!account || !hasInstagramCredentials(account)) {
        failed.push({ user: label, error: "account has no credentials" });
        continue;
      }
      const keyword = keywordByAutomation.get(person.automationId) ?? "剪輯";
      const message = REPLY_VARIANTS[n++ % REPLY_VARIANTS.length].replace("{kw}", keyword);
      try {
        const igContext = await createInstagramContext(account, `launch-reply:${person.commentId}`);
        await sendCommentReply({ context: igContext, commentId: person.commentId, message });
        await redis.sadd(REPLIED_KEY, person.commenterId);
        sent.push(label);
        throttled = 0;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failed.push({ user: label, error: detail.slice(0, 200) });
        // A deleted comment will never take a reply; do not retry it.
        if (/does not exist|deleted|Unsupported (get|post) request|code=(100|1)\b/i.test(detail)) {
          await redis.sadd(REPLIED_KEY, person.commenterId);
        }
        if (isInstagramThrottle(error) && ++throttled >= 3) break;
      }
      await sleep(3000);
    }
    return NextResponse.json({
      success: true,
      data: { ...summary, replied: sent, failed, stoppedEarly: throttled >= 3 },
    });
  }
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
        buttons: [{ title: buttonTitle, url: url as string }],
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
