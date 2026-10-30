/**
 * Nudges: when someone the assistant talks to goes quiet, it writes again
 * every few hours with the creator's re-engagement lines, one at a time and in
 * order, until they answer or Instagram's 24-hour window (counted from their
 * last message) would close. Every message they send starts the series over.
 *
 * Off unless switched on for the account; it only runs while the assistant
 * itself is on, respects its test list and campaign scope, and skips
 * conversations the creator took over or the assistant ended (they bought,
 * or were abusive).
 */

import { prisma } from "@/lib/db/client";
import { createInstagramContext, hasInstagramCredentials } from "@/lib/instagram/context";
import { sendDirectMessage } from "@/lib/instagram/send-messages";
import { getRedisConnection } from "@/lib/queue/client";
import { AI_NUDGE_JOB_NAME, getAiQueue, type AiNudgeJob } from "./queue";
import { isAiPaused, isConversationEnded } from "./takeover";
import { inAssistantScope } from "./trigger";

export const NUDGE_LIMITS = { messages: 6, messageLength: 300, minHours: 1, maxHours: 23 } as const;
// Instagram's window is 24 hours; the last nudge must leave room to deliver.
const WINDOW_MS = 23.5 * 60 * 60 * 1000;
const STOP_INTENTS = ["already_joined", "declined"];

export type NudgeSettings = { enabled: boolean; intervalHours: number; messages: string[] };

const settingsKey = (accountId: string) => `ai:nudges:${accountId}`;
// When the person last wrote: a due nudge from an older silence is stale.
const quietSinceKey = (accountId: string, igsid: string) => `ai:nudge-since:${accountId}:${igsid}`;

export async function getNudgeSettings(accountId: string): Promise<NudgeSettings> {
  const raw = await getRedisConnection().hgetall(settingsKey(accountId));
  let messages: string[] = [];
  try {
    messages = JSON.parse(raw.messages ?? "[]");
  } catch {
    messages = [];
  }
  return {
    enabled: raw.enabled === "1",
    intervalHours: Number(raw.intervalHours ?? 5),
    messages: Array.isArray(messages) ? messages.filter((m) => typeof m === "string" && m.trim()) : [],
  };
}

export async function setNudgeSettings(accountId: string, settings: NudgeSettings): Promise<void> {
  await getRedisConnection().hset(settingsKey(accountId), {
    enabled: settings.enabled ? "1" : "0",
    intervalHours: String(settings.intervalHours),
    messages: JSON.stringify(settings.messages),
  });
}

/** The nudge times after a message at `since`: every interval, inside the window. */
export function nudgeDelays(intervalHours: number, count: number): number[] {
  const step = intervalHours * 60 * 60 * 1000;
  const delays: number[] = [];
  for (let i = 1; i <= count && i * step <= WINDOW_MS; i++) delays.push(i * step);
  return delays;
}

/**
 * A message from the person: start the series over from now. Best-effort, so
 * a scheduling failure never fails the message it follows.
 */
export async function scheduleNudgesAfterMessage(instagramId: string, igsid: string): Promise<void> {
  try {
    const account = await prisma.instagramAccount.findFirst({
      where: { instagramId, provider: "META" },
      select: { id: true, aiAssistant: { select: { enabled: true, campaignIds: true } } },
    });
    if (!account?.aiAssistant?.enabled) return;
    const settings = await getNudgeSettings(account.id);
    const [first] = nudgeDelays(settings.intervalHours, settings.messages.length);
    if (!settings.enabled || first === undefined) return;
    if (!(await inAssistantScope(account.aiAssistant.campaignIds ?? [], igsid))) return;

    const since = Date.now();
    await getRedisConnection().set(quietSinceKey(account.id, igsid), String(since), "PX", WINDOW_MS);
    const data: AiNudgeJob = { accountId: account.id, igsid, since, step: 0 };
    await getAiQueue().add(AI_NUDGE_JOB_NAME, data, {
      delay: first,
      jobId: `ai-nudge_${account.id}_${igsid}_${since}_0`,
      removeOnComplete: true,
      removeOnFail: true,
    });
  } catch (error) {
    console.error("[AI nudge] Could not schedule:", error instanceof Error ? error.message : error);
  }
}

/** Why a due nudge should not go out, or null to send it. */
async function nudgeBlockedReason(job: AiNudgeJob, settings: NudgeSettings): Promise<string | null> {
  const { accountId, igsid, since } = job;
  if (!settings.enabled) return "nudges are off";
  if (Date.now() - since > WINDOW_MS) return "the 24-hour window closed";
  const current = await getRedisConnection().get(quietSinceKey(accountId, igsid));
  if (current !== String(since)) return "they wrote again since";
  if (await isConversationEnded(accountId, igsid)) return "the conversation was ended";
  if (await isAiPaused(accountId, igsid)) return "the creator is answering this conversation";

  const assistant = await prisma.aiAssistant.findUnique({
    where: { instagramAccountId: accountId },
    select: { enabled: true, testUsernames: true, campaignIds: true },
  });
  if (!assistant?.enabled) return "the assistant is off";
  if (!(await inAssistantScope(assistant.campaignIds ?? [], igsid))) return "not from the assistant's campaigns";
  if (assistant.testUsernames.length > 0) {
    const contact = await prisma.contact.findFirst({
      where: { instagramAccountId: accountId, igsid },
      select: { username: true },
    });
    const username = contact?.username?.replace(/^@/, "").toLowerCase();
    if (!username || !assistant.testUsernames.includes(username)) return "not on the AI test list";
  }
  const lastDraft = await prisma.aiDraft.findFirst({
    where: { instagramAccountId: accountId, igsid },
    orderBy: { createdAt: "desc" },
    select: { intent: true },
  });
  if (lastDraft?.intent && STOP_INTENTS.includes(lastDraft.intent)) return `they said ${lastDraft.intent}`;
  return null;
}

/** Send one nudge, then schedule the next one if it still fits the window. */
export async function processAiNudge(job: AiNudgeJob): Promise<"sent" | "skipped" | "failed"> {
  const settings = await getNudgeSettings(job.accountId);
  const blocked = await nudgeBlockedReason(job, settings);
  const message = settings.messages[job.step];
  if (blocked || !message) {
    console.log(`[AI nudge] Skipped step ${job.step + 1}: ${blocked ?? "no message for this step"}`);
    return "skipped";
  }

  const account = await prisma.instagramAccount.findUnique({ where: { id: job.accountId } });
  if (!account || !hasInstagramCredentials(account)) return "skipped";
  try {
    const context = await createInstagramContext(account, `ai-nudge:${job.igsid}:${job.step}`);
    await sendDirectMessage({ context, instagramAccountId: account.instagramId, userId: job.igsid, message });
  } catch (error) {
    console.error("[AI nudge] Could not send:", error instanceof Error ? error.message : error);
    return "failed";
  }

  const delays = nudgeDelays(settings.intervalHours, settings.messages.length);
  const next = job.step + 1;
  if (next < delays.length) {
    const data: AiNudgeJob = { ...job, step: next };
    await getAiQueue().add(AI_NUDGE_JOB_NAME, data, {
      delay: Math.max(0, job.since + delays[next] - Date.now()),
      jobId: `ai-nudge_${job.accountId}_${job.igsid}_${job.since}_${next}`,
      removeOnComplete: true,
      removeOnFail: true,
    });
  }
  return "sent";
}
