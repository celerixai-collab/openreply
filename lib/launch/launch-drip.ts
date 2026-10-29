import { prisma } from "@/lib/db/client";
import {
  createInstagramContext,
  hasInstagramCredentials,
} from "@/lib/instagram/context";
import { sendCommentReply } from "@/lib/instagram/send-messages";
import { isInstagramThrottle } from "@/lib/instagram/delivery-errors";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import {
  pausePublicReplies,
  reservePublicReplySlot,
} from "@/lib/utils/rate-limiter";

/**
 * The "剪輯室" launch announcement for everyone who commented on an A–F
 * waitlist campaign. Instagram only lets us DM someone within 24 hours of
 * their last interaction, so old commenters get a public reply under their
 * comment asking them to answer with the keyword; their answer triggers the
 * campaign's own DM, which carries the purchase link.
 */
export const CAMPAIGN_NAME = /^剪輯室 早鳥等候 [A-F]$/;
export const SENT_KEY = "launch-blast:2026-10-28:sent";
// People Instagram refused because their last interaction is too old.
export const CLOSED_KEY = "launch-blast:2026-10-28:closed";
// People whose old comment already got the public nudge (or could not take one).
export const REPLIED_KEY = "launch-blast:2026-10-28:replied";
// The drip's settings: enabled, budget (replies left), launchAt, workspaceId.
export const DRIP_KEY = "launch-blast:drip";
const DRIP_LOCK_KEY = "launch-blast:drip:lock";

// Positive-emoji public replies, rotated so they do not read as one pasted line.
export const REPLY_VARIANTS = [
  "剪輯系統上線了 🎉 早鳥價 $81 只到 11/6，回覆「{kw}」我馬上私訊連結給你 🙌",
  "Leo 剪輯室開賣了 🔥 早鳥價到 11/6，回覆「{kw}」領取購買連結 ✨",
  "等很久了吧 😆 剪輯系統現在上線，早鳥優惠趕快搶，回覆「{kw}」拿連結 👉",
  "好消息 🎊 AI 剪輯系統開賣，早鳥價只到 11/6，回覆「{kw}」我私訊你連結 💛",
];

// The drip waits while this many DMs are queued, so live commenters go first.
const MAX_DM_BACKLOG = 20;

export type LaunchPerson = {
  instagramAccountId: string;
  commenterId: string;
  commenterName: string | null;
  commentId: string;
  automationId: string;
};

/**
 * Everyone who commented on an A–F campaign, one row per person per account
 * with their latest comment, minus those who already got the purchase DM:
 * the launch DM itself, or the campaign's DM since `launchAt`.
 */
export async function findLaunchAudience(
  workspaceId: string,
  { realCommentsOnly, launchAt }: { realCommentsOnly: boolean; launchAt?: Date },
) {
  const campaigns = (
    await prisma.automation.findMany({
      where: { workspaceId },
      include: { instagramAccount: true },
    })
  ).filter((c) => CAMPAIGN_NAME.test(c.name));
  const campaignIds = campaigns.map((c) => c.id);

  const people: LaunchPerson[] = await prisma.dmLog.findMany({
    where: {
      automationId: { in: campaignIds },
      // Button taps are logged under a made-up "reveal:" id; only real comments take a reply.
      ...(realCommentsOnly ? { NOT: { commentId: { startsWith: "reveal:" } } } : {}),
    },
    distinct: ["instagramAccountId", "commenterId"],
    orderBy: { createdAt: "desc" },
    select: {
      instagramAccountId: true,
      commenterId: true,
      commenterName: true,
      commentId: true,
      automationId: true,
    },
  });

  const gotLink = new Set(await getRedisConnection().smembers(SENT_KEY));
  if (launchAt) {
    const linked = await prisma.dmLog.findMany({
      where: { automationId: { in: campaignIds }, status: "SENT", dmSentAt: { gte: launchAt } },
      distinct: ["commenterId"],
      select: { commenterId: true },
    });
    for (const row of linked) gotLink.add(row.commenterId);
  }

  return { campaigns, people, gotLink };
}

type DripSettings = {
  enabled: boolean;
  budget: number;
  launchAt?: Date;
  workspaceId?: string;
};

export async function getDripSettings(): Promise<DripSettings> {
  const raw = await getRedisConnection().hgetall(DRIP_KEY);
  return {
    enabled: raw.enabled === "1",
    budget: Number(raw.budget ?? 0),
    launchAt: raw.launchAt ? new Date(raw.launchAt) : undefined,
    workspaceId: raw.workspaceId || undefined,
  };
}

export async function setDripSettings(settings: {
  enabled: boolean;
  budget: number;
  launchAt: Date;
  workspaceId: string;
}): Promise<void> {
  await getRedisConnection().hset(DRIP_KEY, {
    enabled: settings.enabled ? "1" : "0",
    budget: String(settings.budget),
    launchAt: settings.launchAt.toISOString(),
    workspaceId: settings.workspaceId,
  });
}

/**
 * One step of the drip, run by the worker every minute: post at most one
 * public reply. It shares the public-reply pace and cooldown with the live
 * campaigns, waits while DMs are queued, and stops itself when the budget
 * runs out or nobody is left.
 */
export async function runLaunchDripTick(): Promise<void> {
  const settings = await getDripSettings();
  if (!settings.enabled || settings.budget <= 0 || !settings.workspaceId) return;

  const redis = getRedisConnection();
  if (!(await redis.set(DRIP_LOCK_KEY, "1", "PX", 55_000, "NX"))) return;

  const counts = await getDMQueue().getJobCounts("waiting", "delayed", "active");
  if ((counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0) > MAX_DM_BACKLOG) return;

  const { campaigns, people, gotLink } = await findLaunchAudience(settings.workspaceId, {
    realCommentsOnly: true,
    launchAt: settings.launchAt,
  });
  const replied = new Set(await redis.smembers(REPLIED_KEY));
  const person = people.find((p) => !gotLink.has(p.commenterId) && !replied.has(p.commenterId));
  if (!person) {
    await redis.hset(DRIP_KEY, "enabled", "0");
    console.log("[Launch drip] Everyone has been replied to; drip turned off");
    return;
  }

  const campaign = campaigns.find((c) => c.id === person.automationId);
  const account = campaign?.instagramAccount;
  if (!campaign || !account || !hasInstagramCredentials(account)) {
    await redis.sadd(REPLIED_KEY, person.commenterId);
    return;
  }
  if (!(await reservePublicReplySlot(person.instagramAccountId))) return;

  const keyword = campaign.keywords?.[0] ?? "剪輯";
  const message = REPLY_VARIANTS[replied.size % REPLY_VARIANTS.length].replace("{kw}", keyword);
  const label = person.commenterName ?? person.commenterId;
  try {
    const igContext = await createInstagramContext(account, `launch-reply:${person.commentId}`);
    await sendCommentReply({ context: igContext, commentId: person.commentId, message });
    await redis.sadd(REPLIED_KEY, person.commenterId);
    const left = await redis.hincrby(DRIP_KEY, "budget", -1);
    console.log(`[Launch drip] Replied to ${label}; ${left} left in budget`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[Launch drip] Reply to ${label} failed:`, detail.slice(0, 300));
    // Volume pushback pauses replies and this person is tried again later.
    // Anything else (a deleted comment, an unclear outcome) is not retried,
    // so one bad comment cannot hold up the queue or be answered twice.
    if (isInstagramThrottle(error) || /\b368\b|spam/i.test(detail)) {
      await pausePublicReplies(person.instagramAccountId);
    } else {
      await redis.sadd(REPLIED_KEY, person.commenterId);
    }
  }
}
