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
  sendPrivateReplyWithLinkButton,
} from "@/lib/instagram/send-messages";
import { isInstagramThrottle, isPermanentRejection } from "@/lib/instagram/delivery-errors";
import { getRedisConnection } from "@/lib/queue/client";
import {
  CLOSED_KEY,
  REPLIED_KEY,
  REPLY_VARIANTS,
  SENT_KEY,
  findLaunchAudience,
  getDripSettings,
  setDripSettings,
} from "@/lib/launch/launch-drip";
import { getOwedSettings, OWED_TEST_KEY, setOwedSettings } from "@/lib/launch/owed-link";

/**
 * One-off launch announcement to everyone who ever commented on a
 * "剪輯室 早鳥等候 A–F" campaign. Owners and admins only. "dm" and "reply"
 * send one batch now; "drip" switches the worker's background public replies
 * on or off and reports how far they have got.
 */
const bodySchema = z.object({
  // "dm": the announcement DM with a link button. "reply": a public reply under
  // the person's latest comment that asks them to answer with the keyword, which
  // re-opens the messaging window for the campaign's own DM.
  mode: z.enum(["dm", "reply", "drip", "recent", "owed"]).default("dm"),
  text: z.string().max(600).default(""),
  buttonTitle: z.string().max(20).default(""),
  url: z.string().url().optional(),
  limit: z.number().int().min(1).max(40).default(10),
  dryRun: z.boolean().default(false),
  // Send only to these Instagram usernames (test sends).
  usernames: z.array(z.string().min(1)).max(25).optional(),
  // People whose campaign DM was sent at or after this time already have the
  // purchase link and are skipped.
  launchAt: z.string().datetime({ offset: true }).optional(),
  // drip mode: switch it on or off, and how many replies it may post in all.
  enabled: z.boolean().optional(),
  budget: z.number().int().min(0).max(5000).optional(),
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
  const launchAt = parsed.data.launchAt ? new Date(parsed.data.launchAt) : undefined;
  if ((mode === "dm" || mode === "recent") && (!text || !buttonTitle || !url)) {
    return NextResponse.json({ success: false, error: `${mode} mode needs text, buttonTitle and url` }, { status: 400 });
  }
  const workspaceId = context.workspaceId;

  const redis = getRedisConnection();
  const drip = await getDripSettings();
  const { campaigns, people, gotLink } = await findLaunchAudience(workspaceId, {
    realCommentsOnly: mode !== "dm",
    launchAt: launchAt ?? (mode === "owed" ? (await getOwedSettings()).launchAt : drip.launchAt),
  });
  if (campaigns.length === 0) {
    return NextResponse.json({ success: false, error: "No A–F campaigns found" }, { status: 404 });
  }
  const accountById = new Map(campaigns.map((c) => [c.instagramAccountId, c.instagramAccount]));
  const keywordByAutomation = new Map(campaigns.map((c) => [c.id, c.keywords?.[0] ?? "剪輯"]));
  const closed = new Set(await redis.smembers(CLOSED_KEY));
  const replied = new Set(await redis.smembers(REPLIED_KEY));

  if (mode === "drip") {
    if (parsed.data.enabled !== undefined) {
      const effectiveLaunchAt = launchAt ?? drip.launchAt;
      if (parsed.data.enabled && !effectiveLaunchAt) {
        return NextResponse.json({ success: false, error: "drip needs launchAt the first time" }, { status: 400 });
      }
      await setDripSettings({
        enabled: parsed.data.enabled,
        budget: parsed.data.budget ?? drip.budget,
        launchAt: effectiveLaunchAt ?? new Date(),
        workspaceId,
      });
    }
    const now = await getDripSettings();
    const left = people.filter((p) => !gotLink.has(p.commenterId) && !replied.has(p.commenterId));
    return NextResponse.json({
      success: true,
      data: {
        enabled: now.enabled,
        budget: now.budget,
        launchAt: now.launchAt?.toISOString() ?? null,
        uniquePeople: people.length,
        alreadyHaveLink: people.filter((p) => gotLink.has(p.commenterId)).length,
        replied: replied.size,
        left: left.length,
        next: left.slice(0, 5).map((p) => p.commenterName ?? p.commenterId),
      },
    });
  }

  if (mode === "owed") {
    // Switch the owed-link delivery on or off and report who is still owed.
    const current = await getOwedSettings();
    if (parsed.data.enabled !== undefined) {
      const nextText = text || current.text;
      const nextUrl = url ?? current.url;
      const nextLaunchAt = launchAt ?? current.launchAt;
      if (parsed.data.enabled && (!nextText || !nextUrl || !nextLaunchAt)) {
        return NextResponse.json({ success: false, error: "owed needs text, url and launchAt the first time" }, { status: 400 });
      }
      await setOwedSettings({
        enabled: parsed.data.enabled,
        text: nextText,
        buttonTitle: buttonTitle || current.buttonTitle,
        url: nextUrl,
        launchAt: nextLaunchAt ?? new Date(),
      });
    }
    // Test accounts: treated as owed on their next interaction, once per call.
    let testPeople: string[] | undefined;
    if (usernames?.length) {
      const wanted = usernames.map((u) => u.replace(/^@/, "").toLowerCase());
      const contacts = await prisma.contact.findMany({
        where: { workspaceId, username: { in: wanted, mode: "insensitive" } },
        select: { igsid: true, username: true },
      });
      for (const c of contacts) {
        await redis.sadd(OWED_TEST_KEY, c.igsid);
        await redis.srem(SENT_KEY, c.igsid);
      }
      testPeople = contacts.map((c) => c.username ?? c.igsid);
    }
    const now = await getOwedSettings();
    return NextResponse.json({
      success: true,
      data: {
        testPeople,
        enabled: now.enabled,
        text: now.text,
        buttonTitle: now.buttonTitle,
        url: now.url,
        launchAt: now.launchAt?.toISOString() ?? null,
        uniquePeople: people.length,
        stillOwed: people.filter((p) => !gotLink.has(p.commenterId)).length,
      },
    });
  }

  if (mode === "recent") {
    // Everyone Instagram still lets us message directly: a comment from the
    // last 7 days that never got a private reply takes one, and anyone who
    // tapped a button in the last 24 hours can be sent a plain DM.
    const now = Date.now();
    const logs = await prisma.dmLog.findMany({
      where: {
        automationId: { in: campaigns.map((c) => c.id) },
        createdAt: { gte: new Date(now - 7 * 24 * 3600 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      select: {
        instagramAccountId: true,
        commenterId: true,
        commenterName: true,
        commentId: true,
        status: true,
        errorMessage: true,
        createdAt: true,
      },
    });
    type Target = { log: (typeof logs)[number]; via: "private" | "dm" };
    const targets = new Map<string, Target>();
    for (const log of logs) {
      if (gotLink.has(log.commenterId) || closed.has(log.commenterId) || targets.has(log.commenterId)) continue;
      const isComment = !log.commentId.startsWith("reveal:");
      if (isComment && log.status !== "SENT" && !/invalid for a private reply/i.test(log.errorMessage ?? "")) {
        targets.set(log.commenterId, { log, via: "private" });
      }
    }
    for (const log of logs) {
      if (gotLink.has(log.commenterId) || closed.has(log.commenterId) || targets.has(log.commenterId)) continue;
      if (log.commentId.startsWith("reveal:") && now - log.createdAt.getTime() < 23 * 3600 * 1000) {
        targets.set(log.commenterId, { log, via: "dm" });
      }
    }
    const all = [...targets.values()];
    const batch = all.slice(0, limit);
    const counts = {
      privateReply: all.filter((t) => t.via === "private").length,
      dm: all.filter((t) => t.via === "dm").length,
    };
    if (dryRun) {
      return NextResponse.json({
        success: true,
        data: { ...counts, total: all.length, wouldSend: batch.map((t) => `${t.log.commenterName ?? t.log.commenterId} (${t.via})`) },
      });
    }
    const sent: string[] = [];
    const failed: { user: string; error: string }[] = [];
    let throttled = 0;
    for (const { log, via } of batch) {
      const label = log.commenterName ?? log.commenterId;
      const account = accountById.get(log.instagramAccountId);
      if (!account || !hasInstagramCredentials(account)) {
        failed.push({ user: label, error: "account has no credentials" });
        continue;
      }
      try {
        const igContext = await createInstagramContext(account, `launch-recent:${log.commentId}`);
        const buttons = [{ title: buttonTitle, url: url as string }];
        if (via === "private") {
          await sendPrivateReplyWithLinkButton({
            context: igContext,
            instagramAccountId: account.instagramId,
            commentId: log.commentId,
            text,
            buttons,
          });
        } else {
          await sendDirectMessageWithLinkButton({
            context: igContext,
            instagramAccountId: account.instagramId,
            userId: log.commenterId,
            text,
            buttons,
          });
        }
        await redis.sadd(SENT_KEY, log.commenterId);
        sent.push(`${label} (${via})`);
        throttled = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ user: `${label} (${via})`, error: message.slice(0, 200) });
        if (isPermanentRejection(error)) await redis.sadd(CLOSED_KEY, log.commenterId);
        if (isInstagramThrottle(error) && ++throttled >= 3) break;
      }
      await sleep(1500);
    }
    return NextResponse.json({
      success: true,
      data: { ...counts, total: all.length, sent, failed, stoppedEarly: throttled >= 3 },
    });
  }

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
      !gotLink.has(p.commenterId) &&
      (mode === "reply"
        ? !replied.has(p.commenterId)
        : !closed.has(p.commenterId) || Boolean(usernames?.length)) &&
      (!targetIgsids || targetIgsids.has(p.commenterId))
  );
  const batch = pending.slice(0, limit);

  const summary = {
    campaigns: campaigns.length,
    uniquePeople: people.length,
    alreadySent: gotLink.size,
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
