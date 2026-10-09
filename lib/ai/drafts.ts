/**
 * Draft bookkeeping shared by the API routes and the worker. No Anthropic
 * SDK import: the web app runs this without ANTHROPIC_API_KEY.
 */

import { prisma } from "@/lib/db/client";
import type { AiDraftStatus } from "@/app/generated/prisma/client";
import {
  DM_WINDOW_MS,
  MAX_DM_TEXT_BYTES,
  composeOutgoingText,
  outgoingTextFits,
  replyWindowEndsAt,
  utf8ByteLength,
} from "./constants";
import { getAiQueue, SEND_AI_DRAFT_JOB_NAME, sendAiDraftJobId } from "./queue";

// Drafts that can still be sent: a FAILED one is a confirmed non-delivery
// (or a draft the model could not write), so typing a reply and sending it
// is safe. SENDING is never re-sent: its outcome may be unconfirmed.
export const SENDABLE_STATUSES: AiDraftStatus[] = ["PENDING", "FAILED"];
export const HISTORY_STATUSES: AiDraftStatus[] = [
  "SENT",
  "DISMISSED",
  "EXPIRED",
  "FAILED",
  "SUPERSEDED",
];

/** PENDING drafts whose 24-hour window has closed can no longer be sent. */
export async function expireStaleAiDrafts(
  scope: { workspaceId?: string } = {},
  now: Date = new Date()
): Promise<number> {
  const { count } = await prisma.aiDraft.updateMany({
    where: {
      ...scope,
      status: "PENDING",
      inboundAt: { lt: new Date(now.getTime() - DM_WINDOW_MS) },
    },
    data: { status: "EXPIRED", decidedAt: now },
  });
  return count;
}

type PersonKey = { instagramAccountId: string; igsid: string };

/** The newest inbound message we know of from each person. */
export async function latestInboundByPerson(
  people: PersonKey[]
): Promise<Map<string, Date>> {
  const map = new Map<string, Date>();
  if (!people.length) return map;
  const rows = await prisma.aiDraft.groupBy({
    by: ["instagramAccountId", "igsid"],
    where: { OR: people },
    _max: { inboundAt: true },
  });
  for (const row of rows) {
    if (row._max.inboundAt) map.set(personKey(row), row._max.inboundAt);
  }
  return map;
}

/** People who have already received an AI reply (no disclosure needed). */
export async function peopleWithSentReply(people: PersonKey[]): Promise<Set<string>> {
  if (!people.length) return new Set();
  const rows = await prisma.aiDraft.findMany({
    where: { OR: people, status: "SENT" },
    select: { instagramAccountId: true, igsid: true },
    distinct: ["instagramAccountId", "igsid"],
  });
  return new Set(rows.map(personKey));
}

export function personKey(person: PersonKey): string {
  return `${person.instagramAccountId}:${person.igsid}`;
}

export type SendResult =
  | { ok: true; status: "SENDING" }
  | { ok: false; httpStatus: number; error: string; code: string; bytes?: number };

/**
 * Approve a draft: validate, check the 24-hour window, flip PENDING/FAILED to
 * SENDING with a compare-and-set (two clicks, two tabs or two people get one
 * send), then queue the delivery for the worker.
 */
export async function requestDraftSend({
  workspaceId,
  draftId,
  text,
  now = new Date(),
}: {
  workspaceId: string;
  draftId: string;
  text: unknown;
  now?: Date;
}): Promise<SendResult> {
  const body = typeof text === "string" ? text.trim() : "";
  if (!body) {
    return { ok: false, httpStatus: 400, code: "empty", error: "The reply is empty" };
  }

  const draft = await prisma.aiDraft.findFirst({
    where: { id: draftId, workspaceId },
    select: {
      id: true,
      status: true,
      igsid: true,
      instagramAccountId: true,
      instagramAccount: { select: { aiAssistant: { select: { disclosureText: true } } } },
    },
  });
  if (!draft) {
    return { ok: false, httpStatus: 404, code: "not_found", error: "Draft not found" };
  }
  if (!SENDABLE_STATUSES.includes(draft.status)) {
    return {
      ok: false,
      httpStatus: 409,
      code: "not_sendable",
      error: `This draft is ${draft.status.toLowerCase()} and can no longer be sent`,
    };
  }

  const person = { instagramAccountId: draft.instagramAccountId, igsid: draft.igsid };
  const firstReply = !(await peopleWithSentReply([person])).has(personKey(person));
  const disclosure = draft.instagramAccount.aiAssistant?.disclosureText ?? "";
  const finalText = composeOutgoingText(body, disclosure, firstReply);
  if (!outgoingTextFits(finalText)) {
    return {
      ok: false,
      httpStatus: 400,
      code: "too_long",
      bytes: utf8ByteLength(finalText),
      error: `The reply is ${utf8ByteLength(finalText)} bytes; Instagram allows ${MAX_DM_TEXT_BYTES}`,
    };
  }

  const latest = (await latestInboundByPerson([person])).get(personKey(person));
  if (!latest || replyWindowEndsAt(latest).getTime() <= now.getTime()) {
    await prisma.aiDraft.updateMany({
      where: { id: draft.id, status: { in: SENDABLE_STATUSES } },
      data: { status: "EXPIRED", decidedAt: now },
    });
    return {
      ok: false,
      httpStatus: 410,
      code: "window_closed",
      error:
        "Instagram's 24-hour reply window has closed. Reply in the Instagram app once they message again.",
    };
  }

  const claimed = await prisma.aiDraft.updateMany({
    where: { id: draft.id, workspaceId, status: { in: SENDABLE_STATUSES } },
    data: { status: "SENDING", finalText, error: null, decidedAt: now },
  });
  if (claimed.count === 0) {
    return {
      ok: false,
      httpStatus: 409,
      code: "not_sendable",
      error: "This draft was already sent or changed",
    };
  }

  try {
    await getAiQueue().add(
      SEND_AI_DRAFT_JOB_NAME,
      { draftId: draft.id },
      // A FAILED draft can be sent again, so each send gets its own job id;
      // the compare-and-set above is what prevents a double send.
      { jobId: `${sendAiDraftJobId(draft.id)}_${now.getTime()}` }
    );
  } catch {
    await prisma.aiDraft.updateMany({
      where: { id: draft.id, status: "SENDING" },
      data: { status: draft.status, finalText: null, decidedAt: null },
    });
    return {
      ok: false,
      httpStatus: 503,
      code: "queue_unavailable",
      error: "The send queue is unavailable. Try again in a moment.",
    };
  }
  return { ok: true, status: "SENDING" };
}

export async function dismissDraft({
  workspaceId,
  draftId,
  now = new Date(),
}: {
  workspaceId: string;
  draftId: string;
  now?: Date;
}): Promise<boolean> {
  const { count } = await prisma.aiDraft.updateMany({
    where: { id: draftId, workspaceId, status: { in: SENDABLE_STATUSES } },
    data: { status: "DISMISSED", decidedAt: now },
  });
  return count > 0;
}

const PENDING_VIEW: AiDraftStatus[] = ["PENDING", "SENDING"];

/** Query string of GET /api/ai/drafts: a view (pending/history), an
 * optional status inside history, an account and paging. */
export function parseDraftQuery(params: URLSearchParams) {
  const view = params.get("view") === "history" ? "history" : "pending";
  const requested = params.get("status")?.toUpperCase() as AiDraftStatus | undefined;
  const statuses =
    view === "pending"
      ? PENDING_VIEW
      : requested && HISTORY_STATUSES.includes(requested)
        ? [requested]
        : HISTORY_STATUSES;
  const page = Math.max(1, Math.floor(Number(params.get("page")) || 1));
  const limit = Math.min(50, Math.max(1, Math.floor(Number(params.get("limit")) || 20)));
  const accountId = params.get("accountId") || null;
  return { view, statuses, page, limit, skip: (page - 1) * limit, accountId };
}
