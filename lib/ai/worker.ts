/**
 * The AI assistant's worker: writes drafts (ai-draft) and delivers approved
 * ones (send-ai-draft). Draft mode only - nothing reaches Instagram without a
 * person approving it in the dashboard.
 */

import { UnrecoverableError, Worker, type Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@/app/generated/prisma/client";
import { getRedisConnection } from "@/lib/queue/client";
import { recordWorkerAlert } from "@/lib/ops/worker-health";
import {
  classifySendError,
  isConfirmedSendRejection,
} from "@/lib/instagram/delivery-errors";
import {
  createInstagramContext,
  hasInstagramCredentials,
  sendDirectMessage,
} from "@/lib/instagram/provider";
import { claimOnce } from "@/lib/contacts/contacts";
import { AI_MODEL, DM_WINDOW_MS } from "./constants";
import { getAnthropicClient, isAiConfigured, type AnthropicMessagesClient } from "./client";
import {
  classifyAnthropicError,
  finalizeDraft,
  generateDraftReply,
} from "./generate";
import { loadConversationHistory, type LoadedTurn } from "./history";
import { buildSystemBlocks, buildUserMessage, type HistoryTurn } from "./prompt";
import {
  AI_DRAFT_JOB_NAME,
  AI_QUEUE_NAME,
  SEND_AI_DRAFT_JOB_NAME,
  type AiDraftJob,
  type AiQueueJob,
  type SendAiDraftJob,
} from "./queue";
import { clearBurstThrough, readBurst, type BurstMessage } from "./trigger";

export type AiWorkerDeps = {
  getClient: () => AnthropicMessagesClient;
};

const defaultDeps: AiWorkerDeps = { getClient: getAnthropicClient };

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error";
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export type DraftOutcome =
  | "skipped"
  | "duplicate"
  | "superseded"
  | "answered"
  | "capped"
  | "created"
  | "failed";

/**
 * Write one draft. The job for the newest message of a burst writes a single
 * draft covering the whole burst; jobs for older messages stop here.
 */
export async function processAiDraft(
  job: Pick<Job<AiDraftJob>, "data" | "attemptsMade" | "opts">,
  deps: AiWorkerDeps = defaultDeps
): Promise<DraftOutcome> {
  const { accountId, igsid, messageId, receivedAt } = job.data;
  if (!isAiConfigured()) return "skipped";

  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    include: { aiAssistant: true },
  });
  const assistant = account?.aiAssistant;
  if (!account || account.provider !== "META" || !assistant?.enabled) return "skipped";

  const existing = await prisma.aiDraft.findUnique({
    where: {
      instagramAccountId_inboundMessageId: {
        instagramAccountId: account.id,
        inboundMessageId: messageId,
      },
    },
    select: { id: true },
  });
  if (existing) return "duplicate";

  // Debounce: a newer message from this person has its own job, which will
  // cover this one too.
  const burst = await readBurst(account.id, igsid);
  const newest = burst.at(-1);
  if (newest && newest.id !== messageId) {
    console.log(`[AI Worker] Draft for ${messageId} left to a newer message`);
    return "superseded";
  }
  const index = burst.findIndex((entry) => entry.id === messageId);
  const burstMessages: BurstMessage[] =
    index >= 0
      ? burst.slice(0, index + 1)
      : [{ id: messageId, text: job.data.messageText ?? "", at: receivedAt }];

  const since = new Date(Date.now() - DM_WINDOW_MS);
  const recentDrafts = await prisma.aiDraft.count({
    where: { instagramAccountId: account.id, igsid, createdAt: { gte: since } },
  });
  if (recentDrafts >= assistant.dailyDraftCapPerPerson) {
    console.log(
      `[AI Worker] Daily draft cap (${assistant.dailyDraftCapPerPerson}) reached for a person on account ${account.id}; no draft`
    );
    await clearBurstThrough(account.id, igsid, burst, messageId);
    return "capped";
  }

  const contact = await prisma.contact.findUnique({
    where: { instagramAccountId_igsid: { instagramAccountId: account.id, igsid } },
    select: { id: true, username: true },
  });
  const alreadyReplied = await prisma.aiDraft.findFirst({
    where: { instagramAccountId: account.id, igsid, status: "SENT" },
    select: { id: true },
  });
  const firstReply = !alreadyReplied;

  // The conversation from Meta, including the creator's own replies. On any
  // failure the draft is written from the burst alone.
  let turns: LoadedTurn[] = [];
  let username = contact?.username ?? null;
  if (hasInstagramCredentials(account)) {
    try {
      const context = await createInstagramContext(account);
      if (context.provider === "META") {
        const loaded = await loadConversationHistory({
          accessToken: context.accessToken,
          igUserId: account.instagramId,
          igsid,
        });
        turns = loaded.turns;
        username = username ?? loaded.username;
      }
    } catch (error) {
      console.warn("[AI Worker] Conversation history unavailable:", describe(error));
    }
  }

  const metaTime = new Map(turns.map((turn) => [turn.id, turn.at]));
  const burstIds = new Set(burstMessages.map((entry) => entry.id));
  const historyTurns: HistoryTurn[] = turns
    .filter((turn) => !burstIds.has(turn.id))
    .map(({ from, text, at }) => ({ from, text, at }));
  const latestTurns: HistoryTurn[] = burstMessages.map((entry) => ({
    from: "person",
    text: entry.text,
    at: metaTime.get(entry.id) ?? new Date(entry.at).toISOString(),
  }));
  const inboundAt = new Date(metaTime.get(messageId) ?? receivedAt);

  // The creator (or another tool) already answered in the Instagram app.
  const lastTurn = turns.at(-1);
  if (
    lastTurn?.from === "creator" &&
    lastTurn.at &&
    !burstIds.has(lastTurn.id) &&
    Date.parse(lastTurn.at) > inboundAt.getTime()
  ) {
    await clearBurstThrough(account.id, igsid, burst, messageId);
    return "answered";
  }

  const base = {
    workspaceId: account.workspaceId,
    instagramAccountId: account.id,
    contactId: contact?.id ?? null,
    igsid,
    username,
    inboundMessageId: messageId,
    inboundText: burstMessages.map((entry) => entry.text).join("\n"),
    inboundAt,
    historySnapshot: [...historyTurns, ...latestTurns] as unknown as Prisma.InputJsonValue,
    model: assistant.model || AI_MODEL,
  };

  const campaigns = await prisma.automation.findMany({
    where: { instagramAccountId: account.id, isActive: true },
    select: {
      name: true,
      goal: true,
      keywords: true,
      matchAnyWord: true,
      dmTriggerEnabled: true,
      postId: true,
      matchAnyPost: true,
      collectEmail: true,
      requireFollow: true,
    },
    // Fixed order: the list is part of the cached system prompt.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  let draft;
  try {
    const generated = await generateDraftReply({
      client: deps.getClient(),
      model: base.model,
      system: buildSystemBlocks(assistant, campaigns),
      userMessage: buildUserMessage(historyTurns, latestTurns),
    });
    draft = finalizeDraft(generated, {
      disclosureText: assistant.disclosureText,
      firstReply,
    });
  } catch (error) {
    const failure = classifyAnthropicError(error);
    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (failure.retryable && !lastAttempt) throw failure;
    try {
      await prisma.aiDraft.create({
        data: { ...base, status: "FAILED", error: failure.message },
      });
    } catch (createError) {
      if (!isUniqueViolation(createError)) throw createError;
    }
    await clearBurstThrough(account.id, igsid, burst, messageId);
    return "failed";
  }

  const now = new Date();
  try {
    await prisma.$transaction([
      // One open draft per person: an older one no longer answers the
      // conversation as it stands.
      prisma.aiDraft.updateMany({
        where: { instagramAccountId: account.id, igsid, status: "PENDING" },
        data: { status: "SUPERSEDED", decidedAt: now },
      }),
      prisma.aiDraft.create({
        data: {
          ...base,
          draftText: draft.replyText,
          intent: draft.intent,
          needsHuman: draft.needsHuman,
          handoffReason: draft.handoffReason,
          language: draft.language || null,
          confidence: draft.confidence,
          inputTokens: draft.usage.inputTokens,
          outputTokens: draft.usage.outputTokens,
          cacheReadTokens: draft.usage.cacheReadTokens,
        },
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) return "duplicate";
    throw error;
  }
  await clearBurstThrough(account.id, igsid, burst, messageId);
  return "created";
}

export type SendOutcome = "skipped" | "sent" | "failed" | "already_claimed";

/**
 * Deliver an approved draft, at most once. The claim row is durable (it
 * outlives BullMQ retention and process crashes); only a confirmed Meta
 * rejection releases it. Any other error leaves the draft SENDING with the
 * error recorded: delivery is unconfirmed, nothing is retried automatically.
 */
export async function processSendAiDraft(
  job: Pick<Job<SendAiDraftJob>, "data">
): Promise<SendOutcome> {
  const draft = await prisma.aiDraft.findUnique({
    where: { id: job.data.draftId },
    include: { instagramAccount: true },
  });
  if (!draft || draft.status !== "SENDING" || !draft.finalText) return "skipped";

  const account = draft.instagramAccount;
  const fail = async (error: string) => {
    await prisma.aiDraft.updateMany({
      where: { id: draft.id, status: "SENDING" },
      data: { status: "FAILED", error },
    });
    return "failed" as const;
  };
  if (account.provider !== "META") return fail("AI replies are only sent through Meta accounts");
  if (!hasInstagramCredentials(account)) return fail("No Instagram access token available");

  let context;
  try {
    context = await createInstagramContext(account, `ai-draft:${draft.id}`);
  } catch {
    return fail("Failed to decrypt Instagram access token");
  }

  const claimId = `ai-draft-send:${draft.id}`;
  if (!(await claimOnce(claimId))) return "already_claimed";

  let messageId: string | undefined;
  try {
    const result = await sendDirectMessage({
      context,
      instagramAccountId: account.instagramId,
      userId: draft.igsid,
      message: draft.finalText,
    });
    messageId = result?.message_id;
  } catch (error) {
    if (isConfirmedSendRejection(error)) {
      // Nothing was delivered, so a later send may try again.
      await prisma.postbackDelivery.delete({ where: { id: claimId } });
      return fail(describe(error));
    }
    const unconfirmed = classifySendError(error);
    await prisma.aiDraft.updateMany({
      where: { id: draft.id, status: "SENDING" },
      data: { error: describe(unconfirmed) },
    });
    throw new UnrecoverableError(describe(unconfirmed));
  }

  const sentAt = new Date();
  await prisma.aiDraft.updateMany({
    where: { id: draft.id, status: "SENDING" },
    data: { status: "SENT", sentAt, sentMessageId: messageId ?? null, error: null },
  });
  return "sent";
}

export async function processAiJob(
  job: Job<AiQueueJob>,
  deps: AiWorkerDeps = defaultDeps
): Promise<void> {
  if (job.name === AI_DRAFT_JOB_NAME) {
    await processAiDraft(job as Job<AiDraftJob>, deps);
    return;
  }
  if (job.name === SEND_AI_DRAFT_JOB_NAME) {
    await processSendAiDraft(job as Job<SendAiDraftJob>);
  }
}

export function createAiWorker(): Worker<AiQueueJob> {
  const worker = new Worker<AiQueueJob>(AI_QUEUE_NAME, (job) => processAiJob(job), {
    connection: getRedisConnection(),
    concurrency: 3,
  });
  worker.on("failed", (job, error) => {
    console.error(`[AI Worker] Job ${job?.id} failed:`, error.message);
    void recordWorkerAlert({
      level: "error",
      message: `AI assistant: ${error.message}`,
      jobId: job?.id,
    }).catch(() => undefined);
  });
  worker.on("error", (error) => {
    console.error("[AI Worker] Worker error:", error.message);
  });
  return worker;
}
