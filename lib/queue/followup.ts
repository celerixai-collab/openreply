import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { isAiPaused, isConversationEnded } from "@/lib/ai/takeover";
import { FOLLOWUP_JOB_NAME, getDMQueue } from "@/lib/queue/client";
import { hashRecipientId } from "@/lib/tracking/server";

/**
 * The campaign follow-up: one message per person per campaign, sent once the
 * conversation has been quiet for followUpDelayMinutes. Instagram only lets
 * the account write again after the person tapped or messaged (the 24-hour
 * window), so it is scheduled on a button tap and on any message they send,
 * and each new message pushes it back to that much after their latest one.
 * One per person per account: someone who commented on two campaigns gets
 * the follow-up of the first one scheduled, not both.
 */

type FollowUpCampaign = {
  id: string;
  instagramAccountId: string;
  followUpEnabled: boolean;
  followUpMessage: string | null;
  followUpDelayMinutes: number | null;
  instagramAccount: { instagramId: string };
};

export function followUpJobId(accountId: string, userId: string) {
  return `followup_${accountId}_${userId}`;
}

/** Best-effort: a scheduling failure must never fail the send it follows. */
export async function scheduleFollowUp(
  automation: FollowUpCampaign,
  userId: string,
  commenterName: string | null | undefined
): Promise<"scheduled" | "rescheduled" | "skipped" | "failed"> {
  try {
    return await scheduleFollowUpOrThrow(automation, userId, commenterName);
  } catch (error) {
    console.error(
      "[Follow-up] Could not schedule:",
      error instanceof Error ? error.message : error
    );
    return "failed";
  }
}

async function scheduleFollowUpOrThrow(
  automation: FollowUpCampaign,
  userId: string,
  commenterName: string | null | undefined
): Promise<"scheduled" | "rescheduled" | "skipped"> {
  if (!automation.followUpEnabled || !automation.followUpMessage?.trim()) return "skipped";
  const delay = Math.max(0, automation.followUpDelayMinutes ?? 0) * 60_000;
  const queue = getDMQueue();
  const jobId = followUpJobId(automation.instagramAccountId, userId);

  const existing = await queue.getJob(jobId);
  if (existing) {
    // Already sent (or being sent): one follow-up per person.
    if ((await existing.getState()) !== "delayed") return "skipped";
    await existing.changeDelay(delay);
    return "rescheduled";
  }
  await queue.add(
    FOLLOWUP_JOB_NAME,
    {
      instagramAccountId: automation.instagramAccount.instagramId,
      accountConnectionId: automation.instagramAccountId,
      userId,
      automationId: automation.id,
      commenterName: commenterName ?? null,
    },
    { delay, jobId }
  );
  return "scheduled";
}

/**
 * A message from someone: (re)schedule the follow-up of the latest campaign
 * that sent them its opening DM in the last 7 days, if it has one.
 */
export async function scheduleFollowUpAfterMessage(
  instagramId: string,
  senderId: string
): Promise<void> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const log = await prisma.dmLog.findFirst({
    where: {
      commenterId: senderId,
      status: "SENT",
      createdAt: { gte: since },
      automation: {
        isActive: true,
        followUpEnabled: true,
        instagramAccount: { instagramId },
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      commenterName: true,
      automation: {
        select: {
          id: true,
          instagramAccountId: true,
          followUpEnabled: true,
          followUpMessage: true,
          followUpDelayMinutes: true,
          instagramAccount: { select: { instagramId: true } },
        },
      },
    },
  });
  if (!log) return;
  await scheduleFollowUp(log.automation, senderId, log.commenterName);
}

const STOP_INTENTS = ["already_joined", "declined"];

/**
 * Why a due follow-up should not go out, or null to send it: the AI test run
 * is limited to other usernames, the creator took the conversation over, the
 * conversation was ended, they already opened the campaign's link, or they
 * already joined or said no.
 */
export async function followUpBlockedReason(
  automationId: string,
  instagramAccountId: string,
  userId: string
): Promise<string | null> {
  const assistant = await prisma.aiAssistant.findUnique({
    where: { instagramAccountId },
    select: { testUsernames: true, campaignIds: true },
  });
  const testUsernames = assistant?.testUsernames ?? [];
  if (testUsernames.length > 0 && (assistant?.campaignIds ?? []).includes(automationId)) {
    const contact = await prisma.contact.findFirst({
      where: { instagramAccountId, igsid: userId },
      select: { username: true },
    });
    const username = contact?.username?.replace(/^@/, "").toLowerCase();
    if (!username || !testUsernames.includes(username)) return "not on the AI test list";
  }

  if (await isAiPaused(instagramAccountId, userId).catch(() => false)) {
    return "the creator is answering this conversation";
  }
  if (await isConversationEnded(instagramAccountId, userId).catch(() => false)) {
    return "the conversation was ended";
  }
  // Like ManyChat's follow-up: it reminds people who have not opened the link yet.
  const clicked = await prisma.linkClick.findFirst({
    where: { automationId, recipientHash: hashRecipientId(userId) },
    select: { id: true },
  });
  if (clicked) return "they already opened the link";

  const lastDraft = await prisma.aiDraft.findFirst({
    where: { instagramAccountId, igsid: userId },
    orderBy: { createdAt: "desc" },
    select: { intent: true },
  });
  if (lastDraft?.intent && STOP_INTENTS.includes(lastDraft.intent)) {
    return `they ${lastDraft.intent === "declined" ? "declined" : "already joined"}`;
  }
  return null;
}

/**
 * A follow-up can hold several versions separated by a line of dashes; each
 * person gets one of them, always the same one, so the reminders do not all
 * read alike.
 */
export function pickFollowUpMessage(message: string, userId: string): string {
  const variants = message
    .split(/\n-{3,}\n/)
    .map((variant) => variant.trim())
    .filter(Boolean);
  if (variants.length <= 1) return message;
  const hash = createHash("sha256").update(userId).digest();
  return variants[hash.readUInt32BE(0) % variants.length];
}
