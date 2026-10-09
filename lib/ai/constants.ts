// Shared by the worker, the API routes and the AI Assistant page. No server
// imports here, so the page can use the exact limits the server enforces.

import { MAX_DM_TEXT_BYTES, utf8ByteLength } from "@/lib/contacts/email-copy";

// The model is fixed in v1 (Leo's decision). Stored on each assistant and
// each draft so a later change is visible in the data.
export const AI_MODEL = "claude-haiku-5-5";
export const AI_MODEL_LABEL = "Claude Haiku 5.5";

export const AI_MODE_DRAFT = "draft";

export const DEFAULT_DISCLOSURE_TEXT =
  "（我是 AI 小助理，訊息經過本人確認後送出）";
export const DEFAULT_DAILY_DRAFT_CAP = 10;

// Instagram only lets a business answer within 24 hours of the person's
// last message.
export const DM_WINDOW_MS = 24 * 60 * 60 * 1000;

export const AI_DRAFT_STATUSES = [
  "PENDING",
  "SENDING",
  "SENT",
  "DISMISSED",
  "EXPIRED",
  "FAILED",
  "SUPERSEDED",
] as const;
export type AiDraftStatusValue = (typeof AI_DRAFT_STATUSES)[number];

export const AI_INTENTS = [
  "greeting",
  "offer_question",
  "pricing",
  "link_request",
  "collab_or_business",
  "complaint_or_refund",
  "spam_or_abuse",
  "other",
] as const;
export type AiIntent = (typeof AI_INTENTS)[number];

// Intents that always go to a person, whatever the model says.
export const HANDOFF_INTENTS: readonly AiIntent[] = [
  "collab_or_business",
  "complaint_or_refund",
  "spam_or_abuse",
];

export const AI_CONFIDENCE = ["high", "medium", "low"] as const;
export type AiConfidence = (typeof AI_CONFIDENCE)[number];

// Settings limits. The knowledge base is the big one; everything goes into
// one cached system prompt, so these also bound the prompt size.
export const AI_SETTINGS_LIMITS = {
  role: 2000,
  voice: 2000,
  guardrails: 4000,
  knowledge: 50000,
  disclosureText: 200,
  dailyDraftCapMin: 1,
  dailyDraftCapMax: 100,
} as const;

/**
 * The text Instagram receives: the disclosure goes first on the first AI reply
 * a person gets, on its own line.
 */
export function composeOutgoingText(
  text: string,
  disclosureText: string,
  firstReply: boolean
): string {
  const body = text.trim();
  const disclosure = disclosureText.trim();
  return firstReply && disclosure ? `${disclosure}\n${body}` : body;
}

export function outgoingTextFits(text: string): boolean {
  return utf8ByteLength(text) <= MAX_DM_TEXT_BYTES;
}

/** When the 24-hour reply window for a person's latest message closes. */
export function replyWindowEndsAt(latestInboundAt: Date | string): Date {
  return new Date(new Date(latestInboundAt).getTime() + DM_WINDOW_MS);
}

export { MAX_DM_TEXT_BYTES, utf8ByteLength };
