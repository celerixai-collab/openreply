/**
 * Decide whether an inbound DM gets an AI draft, and queue it.
 *
 * Called by processMessage only for a message no email gate answered and no
 * keyword campaign matched, so campaigns always win. Meta accounts only: the
 * Zernio provider has no Conversations API history to give the model.
 */

import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import type { ProcessMessageJob } from "@/lib/queue/client";
import { isAiConfigured } from "./client";
import { maskEmails } from "./history";
import {
  AI_DRAFT_DEBOUNCE_MS,
  AI_DRAFT_ATTEMPTS,
  AI_DRAFT_BACKOFF_MS,
  AI_DRAFT_JOB_NAME,
  aiDraftJobId,
  getAiQueue,
} from "./queue";

const BURST_TTL_SECONDS = 60 * 60;
const BURST_MAX = 20;

export type BurstMessage = { id: string; text: string; at: number };

export function burstKey(accountId: string, igsid: string): string {
  return `ai:burst:${accountId}:${igsid}`;
}

/** Messages from one person not yet answered by a draft, oldest first. */
export async function readBurst(accountId: string, igsid: string): Promise<BurstMessage[]> {
  const values = await getRedisConnection().lrange(burstKey(accountId, igsid), 0, -1);
  const out: BurstMessage[] = [];
  for (const value of values) {
    try {
      const parsed = JSON.parse(value) as BurstMessage;
      if (parsed && typeof parsed.id === "string") out.push(parsed);
    } catch {
      // A corrupt entry is skipped, never fatal.
    }
  }
  return out;
}

/** Drop the burst's messages up to and including `messageId`. */
export async function clearBurstThrough(
  accountId: string,
  igsid: string,
  burst: BurstMessage[],
  messageId: string
): Promise<void> {
  const index = burst.findIndex((entry) => entry.id === messageId);
  if (index < 0) return;
  await getRedisConnection().ltrim(burstKey(accountId, igsid), index + 1, -1);
}

const ATTACHMENT_LABELS: Record<string, string> = {
  share: "分享了一則貼文或 Reels",
  ig_reel: "分享了一支 Reels",
  reel: "分享了一支 Reels",
  ig_post: "分享了一則貼文",
  image: "傳了一張圖片",
  video: "傳了一段影片",
  audio: "傳了一段語音",
  file: "傳了一個檔案",
  story_mention: "在限時動態提到你",
  story_reply: "回覆了你的限時動態",
  like_heart: "傳了一個愛心",
};

/** What a message without text was, as a line the AI can answer. */
export function describeAttachment(type: string | undefined): string {
  if (!type) return "";
  return `（對方${ATTACHMENT_LABELS[type] ?? "傳了一個附件"}，沒有附文字）`;
}

export async function maybeEnqueueAiDraft(
  message: ProcessMessageJob,
  receivedAt: number
): Promise<boolean> {
  // Cheapest checks first: without a key on this worker nothing else runs.
  if (!isAiConfigured()) return false;
  if (message.fromQuickReply) return false;
  const text = message.messageText?.trim() || describeAttachment(message.attachmentType);
  if (!text) return false;

  const account = await prisma.instagramAccount.findFirst({
    where: {
      instagramId: message.instagramAccountId,
      ...(message.accountConnectionId ? { id: message.accountConnectionId } : {}),
    },
    select: {
      id: true,
      provider: true,
      aiAssistant: { select: { enabled: true, campaignIds: true, testUsernames: true } },
    },
  });
  if (!account || account.provider !== "META" || !account.aiAssistant?.enabled) {
    return false;
  }
  // A test run: only the listed usernames get replies.
  const testUsernames = account.aiAssistant.testUsernames ?? [];
  if (testUsernames.length > 0) {
    const contact = await prisma.contact.findFirst({
      where: { instagramAccountId: account.id, igsid: message.senderId },
      select: { username: true },
    });
    const username = contact?.username?.replace(/^@/, "").toLowerCase();
    if (!username || !testUsernames.includes(username)) return false;
  }
  // Limited to some campaigns: only people one of them sent a DM to.
  const campaignIds = account.aiAssistant.campaignIds ?? [];
  if (campaignIds.length > 0) {
    const reached = await prisma.dmLog.findFirst({
      where: { automationId: { in: campaignIds }, commenterId: message.senderId },
      select: { id: true },
    });
    if (!reached) return false;
  }

  // A Meta redelivery of a message that already has a draft: its job id is
  // retained, so BullMQ would ignore the add, but the message must not be
  // put back into the burst either (the next draft would answer it again).
  const answered = await prisma.aiDraft.findUnique({
    where: {
      instagramAccountId_inboundMessageId: {
        instagramAccountId: account.id,
        inboundMessageId: message.messageId,
      },
    },
    select: { id: true },
  });
  if (answered) return false;

  const redis = getRedisConnection();
  const key = burstKey(account.id, message.senderId);
  const entry: BurstMessage = { id: message.messageId, text: maskEmails(text), at: receivedAt };
  // A Meta redelivery must not add the same message twice.
  const existing = await readBurst(account.id, message.senderId);
  if (!existing.some((item) => item.id === message.messageId)) {
    await redis.rpush(key, JSON.stringify(entry));
    await redis.ltrim(key, -BURST_MAX, -1);
  }
  await redis.expire(key, BURST_TTL_SECONDS);

  await getAiQueue().add(
    AI_DRAFT_JOB_NAME,
    {
      accountId: account.id,
      instagramAccountId: message.instagramAccountId,
      igsid: message.senderId,
      messageId: message.messageId,
      messageText: entry.text,
      receivedAt,
    },
    {
      // Same id for a redelivered message: BullMQ ignores the second add.
      jobId: aiDraftJobId(account.id, message.messageId),
      delay: AI_DRAFT_DEBOUNCE_MS,
      attempts: AI_DRAFT_ATTEMPTS,
      backoff: { type: "exponential", delay: AI_DRAFT_BACKOFF_MS },
    }
  );
  return true;
}
