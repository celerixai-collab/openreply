/**
 * The AI assistant's worker: writes drafts (ai-draft), delivers approved
 * ones (send-ai-draft) and steps back when the creator replies by hand
 * (ai-echo). In draft mode nothing reaches Instagram without a person
 * approving it; in auto mode a draft that needs no person is approved by
 * the worker itself, through the same checks as a click in the dashboard.
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
  sendDirectMessageWithLinkButton,
} from "@/lib/instagram/provider";
import { claimOnce } from "@/lib/contacts/contacts";
import {
  AI_MODE_AUTO,
  AI_MODEL,
  DEFAULT_DISCLOSURE_TEXT,
  DM_WINDOW_MS,
  composeOutgoingText,
} from "./constants";
import { writePlaygroundResult, type PlaygroundBrain } from "./playground";
import { requestDraftSend } from "./drafts";
import { isAiPaused, isBotSend, pauseAiFor } from "./takeover";
import { getAnthropicClient, isAiConfigured, type AnthropicMessagesClient } from "./client";
import {
  classifyAnthropicError,
  finalizeDraft,
  generateDraftReply,
} from "./generate";
import { loadConversationHistory, type LoadedTurn } from "./history";
import { buildSystemBlocks, buildUserMessage, type HistoryTurn } from "./prompt";
import { allowedLinkText, compileKnowledge, type BrainLink } from "./brain";
import {
  AI_DRAFT_JOB_NAME,
  AI_ECHO_JOB_NAME,
  AI_PLAYGROUND_JOB_NAME,
  AI_QUEUE_NAME,
  SEND_AI_DRAFT_JOB_NAME,
  type AiDraftJob,
  type AiEchoJob,
  type AiPlaygroundJob,
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
  | "paused"
  | "created"
  | "sent"
  | "failed";

type AssistantPromptSettings = {
  role: string;
  voice: string;
  guardrails: string;
  goals: string;
  knowledge: string;
  // Limit <campaigns> to these (the assistant's campaign scope). Empty: all.
  campaignIds?: string[];
};

/**
 * Everything the model reads about the account: settings, enabled knowledge
 * entries, sendable links and active campaigns, in a fixed order (it is the
 * cached system prompt). Also what the reply may contain: allowed URLs and
 * link ids.
 */
export async function loadAssistantBrain(
  accountId: string,
  assistant: AssistantPromptSettings,
  draft?: Pick<PlaygroundBrain, "entries" | "links">
) {
  const [entries, linkRows, campaigns] = await Promise.all([
    draft
      ? draft.entries.filter((entry) => entry.enabled !== false)
      : prisma.aiKnowledgeEntry.findMany({
          where: { instagramAccountId: accountId, enabled: true },
          orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          select: { title: true, content: true },
        }),
    draft
      ? draft.links.map((link, index) => ({
          id: `draft-link-${index}`,
          label: link.label,
          url: link.url,
          description: link.description ?? "",
        }))
      : prisma.aiLink.findMany({
          where: { instagramAccountId: accountId, enabled: true },
          orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          select: { id: true, label: true, url: true, description: true },
        }),
    prisma.automation.findMany({
      where: {
        instagramAccountId: accountId,
        isActive: true,
        ...(assistant.campaignIds?.length ? { id: { in: assistant.campaignIds } } : {}),
      },
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
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const links: BrainLink[] = linkRows;
  const knowledge = compileKnowledge(entries, assistant.knowledge);
  return {
    system: buildSystemBlocks({ ...assistant, knowledge }, campaigns, links),
    allowedText: allowedLinkText(knowledge, links),
    linkIds: links.map((link) => link.id),
    links,
  };
}

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

  // The creator took this conversation over: stay out until the pause ends.
  if (await isAiPaused(account.id, igsid)) {
    console.log(`[AI Worker] Paused for a person on account ${account.id}: the creator replied`);
    await clearBurstThrough(account.id, igsid, burst, messageId);
    return "paused";
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

  const brain = await loadAssistantBrain(account.id, assistant);

  let draft;
  try {
    const generated = await generateDraftReply({
      client: deps.getClient(),
      model: base.model,
      system: brain.system,
      userMessage: buildUserMessage(historyTurns, latestTurns),
    });
    draft = finalizeDraft(generated, {
      disclosureText: assistant.disclosureText,
      firstReply,
      knowledge: brain.allowedText,
      linkIds: brain.linkIds,
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
  let createdId: string;
  try {
    const [, created] = await prisma.$transaction([
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
          actionLinkId: draft.linkId,
          knowledgeGap: draft.knowledgeGap,
          gapQuestion: draft.gapQuestion,
          inputTokens: draft.usage.inputTokens,
          outputTokens: draft.usage.outputTokens,
          cacheReadTokens: draft.usage.cacheReadTokens,
        },
        select: { id: true },
      }),
    ]);
    createdId = created.id;
  } catch (error) {
    if (isUniqueViolation(error)) return "duplicate";
    throw error;
  }
  await clearBurstThrough(account.id, igsid, burst, messageId);

  // Auto mode: a reply that needs no person goes out now, through the same
  // checks (window, length, one send) as approving it in the dashboard.
  // Hand-offs, low confidence and stray links stay drafts for the creator.
  if (assistant.mode === AI_MODE_AUTO && !draft.needsHuman && draft.replyText) {
    const result = await requestDraftSend({
      workspaceId: account.workspaceId,
      draftId: createdId,
      text: draft.replyText,
    });
    if (result.ok) return "sent";
    console.warn(`[AI Worker] Auto-send held back (${result.code}): ${result.error}`);
  }
  return "created";
}

export type EchoOutcome = "skipped" | "bot" | "paused";

/**
 * A message the account sent. OpenReply's own sends are recorded when they
 * go out; anything else was typed by the creator, so the AI steps back from
 * that conversation and drops the drafts waiting there.
 */
export async function processAiEcho(
  job: Pick<Job<AiEchoJob>, "data">
): Promise<EchoOutcome> {
  const { instagramAccountId, recipientId, messageId, messageText } = job.data;
  // Templates and attachments carry no text: OpenReply's buttons and links
  // arrive that way, so they never count as the creator typing.
  if (!messageText.trim()) return "skipped";

  const account = await prisma.instagramAccount.findFirst({
    where: { instagramId: instagramAccountId, provider: "META" },
    select: { id: true, aiAssistant: { select: { enabled: true, humanPauseHours: true } } },
  });
  const assistant = account?.aiAssistant;
  if (!account || !assistant?.enabled || assistant.humanPauseHours <= 0) return "skipped";

  if (await isBotSend(instagramAccountId, { messageId, text: messageText })) return "bot";

  await pauseAiFor(account.id, recipientId, assistant.humanPauseHours);
  await prisma.aiDraft.updateMany({
    where: { instagramAccountId: account.id, igsid: recipientId, status: "PENDING" },
    data: { status: "SUPERSEDED", decidedAt: new Date() },
  });
  console.log(
    `[AI Worker] The creator replied by hand on account ${account.id}; AI paused for ${assistant.humanPauseHours}h in that conversation`
  );
  return "paused";
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

  // A reply the assistant attached a link to goes out as a button message.
  const link = draft.actionLinkId
    ? await prisma.aiLink.findUnique({ where: { id: draft.actionLinkId } })
    : null;

  let messageId: string | undefined;
  try {
    const result = link
      ? await sendDirectMessageWithLinkButton({
          context,
          instagramAccountId: account.instagramId,
          userId: draft.igsid,
          text: draft.finalText,
          buttons: [{ title: link.label, url: link.url }],
        })
      : await sendDirectMessage({
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

/**
 * A playground run: the same prompt, knowledge, links and checks as a real
 * draft, on a made-up conversation. The result goes to Redis for the page;
 * nothing is sent and nothing is stored as a draft.
 */
export async function processAiPlayground(
  job: Pick<Job<AiPlaygroundJob>, "data">,
  deps: AiWorkerDeps = defaultDeps
): Promise<void> {
  const { playgroundId, accountId, turns, brain: draftBrain } = job.data;
  try {
    if (!isAiConfigured()) {
      await writePlaygroundResult(playgroundId, {
        status: "error",
        error: "ANTHROPIC_API_KEY is not set on the worker",
      });
      return;
    }
    const assistant = await prisma.aiAssistant.findUnique({
      where: { instagramAccountId: accountId },
    });
    const saved = draftBrain?.settings ?? assistant;
    const settings = {
      role: saved?.role ?? "",
      voice: saved?.voice ?? "",
      guardrails: saved?.guardrails ?? "",
      goals: saved?.goals ?? "",
      knowledge: saved?.knowledge ?? "",
      campaignIds: assistant?.campaignIds ?? [],
    };
    const disclosureText = assistant?.disclosureText ?? DEFAULT_DISCLOSURE_TEXT;
    const brain = await loadAssistantBrain(accountId, settings, draftBrain);

    // The trailing messages from the person are what the reply answers.
    let split = turns.length;
    while (split > 0 && turns[split - 1].from === "person") split -= 1;
    const toTurn = (turn: { from: "person" | "creator"; text: string }): HistoryTurn => ({
      from: turn.from,
      text: turn.text,
      at: null,
    });
    const history = turns.slice(0, split).map(toTurn);
    const latest = turns.slice(split).map(toTurn);
    const firstReply = !turns.some((turn) => turn.from === "creator");

    const generated = await generateDraftReply({
      client: deps.getClient(),
      model: assistant?.model || AI_MODEL,
      system: brain.system,
      userMessage: buildUserMessage(history, latest),
    });
    const draft = finalizeDraft(generated, {
      disclosureText,
      firstReply,
      knowledge: brain.allowedText,
      linkIds: brain.linkIds,
    });
    const link = draft.linkId ? brain.links.find((item) => item.id === draft.linkId) ?? null : null;
    await writePlaygroundResult(playgroundId, {
      status: "done",
      replyText: draft.replyText,
      intent: draft.intent,
      needsHuman: draft.needsHuman,
      handoffReason: draft.handoffReason,
      confidence: draft.confidence,
      language: draft.language,
      link: link ? { id: link.id, label: link.label, url: link.url } : null,
      knowledgeGap: draft.knowledgeGap,
      gapQuestion: draft.gapQuestion,
      usedTopics: draft.usedTopics,
      outgoingText: composeOutgoingText(draft.replyText, disclosureText, firstReply),
      wouldAutoSend:
        assistant?.mode === AI_MODE_AUTO && !draft.needsHuman && Boolean(draft.replyText),
    });
  } catch (error) {
    const failure = classifyAnthropicError(error);
    await writePlaygroundResult(playgroundId, { status: "error", error: failure.message }).catch(
      () => undefined
    );
  }
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
    return;
  }
  if (job.name === AI_ECHO_JOB_NAME) {
    await processAiEcho(job as Job<AiEchoJob>);
    return;
  }
  if (job.name === AI_PLAYGROUND_JOB_NAME) {
    await processAiPlayground(job as Job<AiPlaygroundJob>, deps);
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
