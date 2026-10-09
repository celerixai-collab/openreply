/**
 * The AI assistant's own BullMQ queue. Kept apart from dm-processing so its
 * retry policy (seconds, not the 5/15/45-minute campaign backoff) and its
 * concurrency never affect campaign delivery.
 */

import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";

export const AI_QUEUE_NAME = "ai-drafts";
export const AI_DRAFT_JOB_NAME = "ai-draft";
export const SEND_AI_DRAFT_JOB_NAME = "send-ai-draft";

// A burst of messages from one person gets one draft: each message's job
// waits this long, and only the job for the newest message writes it.
export const AI_DRAFT_DEBOUNCE_MS = Number(
  process.env.AI_DRAFT_DEBOUNCE_MS ?? 15_000
);

// Generating a draft: the SDK already retries 429/5xx/connection errors twice
// inside one attempt, so a couple of job attempts a minute apart is enough.
export const AI_DRAFT_ATTEMPTS = 3;
export const AI_DRAFT_BACKOFF_MS = 30_000;

/** Write a draft for one inbound DM (after the debounce delay). */
export interface AiDraftJob {
  // Internal InstagramAccount.id.
  accountId: string;
  // Instagram professional account id (entry.id in webhooks).
  instagramAccountId: string;
  igsid: string;
  messageId: string;
  // Email-masked text, used when the Redis burst list is gone.
  messageText?: string;
  // When the worker saw the message (ms). Meta's own timestamp from the
  // conversation history replaces it when the history loads.
  receivedAt: number;
}

/** Deliver an approved draft. */
export interface SendAiDraftJob {
  draftId: string;
}

export type AiQueueJob = AiDraftJob | SendAiDraftJob;

// BullMQ forbids ":" in custom job ids and Instagram mids can contain it;
// base64url is injective and uses only allowed characters.
export function aiDraftJobId(accountId: string, messageId: string): string {
  return `ai-draft_${accountId}_${Buffer.from(messageId).toString("base64url")}`;
}

export function sendAiDraftJobId(draftId: string): string {
  return `send-ai-draft_${draftId}`;
}

let aiQueue: Queue<AiQueueJob> | null = null;

export function getAiQueue(): Queue<AiQueueJob> {
  if (!aiQueue) {
    aiQueue = new Queue<AiQueueJob>(AI_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        // Kept so a Meta redelivery of the same message id is a no-op add.
        removeOnComplete: { count: 2000 },
        removeOnFail: { age: 24 * 60 * 60, count: 2000 },
        attempts: 1,
      },
    });
  }
  return aiQueue;
}
