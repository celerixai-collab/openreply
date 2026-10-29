/**
 * Human takeover: when the creator answers a person themselves, the AI stays
 * out of that conversation for a while (AiAssistant.humanPauseHours).
 *
 * Instagram echoes every message the account sends, ours included, so an
 * echo alone does not mean a person typed it. Every message OpenReply sends
 * is recorded here (its message id, and a hash of its text in case the echo
 * carries a different id), and an echo matching neither is the creator
 * replying from the Instagram app. Replies sent from OpenReply's own inbox
 * pause the AI directly.
 *
 * Everything here is best-effort: Redis trouble must never block a send or
 * a webhook, so failures are logged and swallowed.
 */

import { createHash } from "node:crypto";
import { getRedisConnection } from "@/lib/queue/client";

// Long enough to outlast any echo delay; Meta delivers echoes in seconds.
const BOT_SENT_TTL_SECONDS = 3 * 24 * 60 * 60;

function botSentKey(instagramId: string): string {
  return `ai:bot-sent:${instagramId}`;
}

function pauseKey(accountId: string, igsid: string): string {
  return `ai:paused:${accountId}:${igsid}`;
}

function textMember(text: string): string {
  const normalized = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  return `t:${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
}

/**
 * Remember a message OpenReply sent from `instagramId` (the professional
 * account id), so its echo is not mistaken for the creator typing.
 */
export async function recordBotSend(
  instagramId: string,
  { messageId, text }: { messageId?: string | null; text?: string | null }
): Promise<void> {
  const members = [
    ...(messageId ? [`m:${messageId}`] : []),
    ...(text?.trim() ? [textMember(text)] : []),
  ];
  // No Redis configured (tests, local scripts): nothing to record into.
  if (!members.length || !process.env.REDIS_URL) return;
  try {
    const redis = getRedisConnection();
    const key = botSentKey(instagramId);
    await redis.sadd(key, ...members);
    await redis.expire(key, BOT_SENT_TTL_SECONDS);
  } catch (error) {
    console.warn(
      "[AI takeover] Could not record a sent message:",
      error instanceof Error ? error.message : error
    );
  }
}

/** Whether an echo is a message OpenReply sent itself. */
export async function isBotSend(
  instagramId: string,
  { messageId, text }: { messageId: string; text: string }
): Promise<boolean> {
  const redis = getRedisConnection();
  const key = botSentKey(instagramId);
  if (await redis.sismember(key, `m:${messageId}`)) return true;
  return Boolean(text.trim()) && Boolean(await redis.sismember(key, textMember(text)));
}

/** Keep the AI out of one conversation for `hours`. 0 turns pausing off. */
export async function pauseAiFor(
  accountId: string,
  igsid: string,
  hours: number
): Promise<void> {
  if (!(hours > 0)) return;
  try {
    await getRedisConnection().set(
      pauseKey(accountId, igsid),
      String(Date.now()),
      "EX",
      Math.round(hours * 60 * 60)
    );
  } catch (error) {
    console.warn(
      "[AI takeover] Could not pause the AI:",
      error instanceof Error ? error.message : error
    );
  }
}

export async function isAiPaused(accountId: string, igsid: string): Promise<boolean> {
  return Boolean(await getRedisConnection().exists(pauseKey(accountId, igsid)));
}

// A conversation the assistant closed for good: the person bought, or was
// abusive or fed up. Nothing more goes to them: no reply, no follow-up.
const ENDED_TTL_SECONDS = 90 * 24 * 60 * 60;

function endedKey(accountId: string, igsid: string): string {
  return `ai:ended:${accountId}:${igsid}`;
}

export async function endConversation(accountId: string, igsid: string): Promise<void> {
  try {
    await getRedisConnection().set(endedKey(accountId, igsid), String(Date.now()), "EX", ENDED_TTL_SECONDS);
  } catch (error) {
    console.warn(
      "[AI takeover] Could not end the conversation:",
      error instanceof Error ? error.message : error
    );
  }
}

export async function isConversationEnded(accountId: string, igsid: string): Promise<boolean> {
  return Boolean(await getRedisConnection().exists(endedKey(accountId, igsid)));
}
