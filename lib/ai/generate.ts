/**
 * The one Claude call: draft a reply as structured JSON.
 *
 * Request shape, per the claude-api skill for Claude Haiku 5.5:
 * - model "claude-haiku-5-5"; no temperature/top_p/top_k (non-default
 *   sampling parameters 400) and no assistant prefill (400) - the output
 *   format comes from structured outputs (`output_config.format`).
 * - adaptive thinking (the only thinking mode; on by default) with
 *   `output_config.effort` set explicitly to "high", the level the skill
 *   names for chat and support assistants where instruction following
 *   matters; max_tokens leaves room for thinking, which counts toward it.
 * - the response is read by block type (it can start with thinking blocks)
 *   and `stop_reason` is checked before the content: "refusal" means a
 *   safety decline with no server-side fallback on this model.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  AI_CONFIDENCE,
  AI_INTENTS,
  HANDOFF_INTENTS,
  MAX_DM_TEXT_BYTES,
  composeOutgoingText,
  type AiConfidence,
  type AiIntent,
} from "./constants";
import { truncateToUtf8Bytes, utf8ByteLength } from "@/lib/contacts/email-copy";
import type { AnthropicMessagesClient } from "./client";

export const DRAFT_MAX_TOKENS = 8000;
export const DRAFT_EFFORT = "high" as const;

// Structured outputs: every object needs additionalProperties: false, all
// fields required; nullable via anyOf. Length limits are not supported in
// the schema, so the reply is cut to Instagram's byte limit in code.
export const DRAFT_REPLY_SCHEMA = {
  type: "object",
  properties: {
    reply_text: { type: "string" },
    intent: { type: "string", enum: [...AI_INTENTS] },
    needs_human: { type: "boolean" },
    handoff_reason: { anyOf: [{ type: "string" }, { type: "null" }] },
    language: { type: "string" },
    confidence: { type: "string", enum: [...AI_CONFIDENCE] },
  },
  required: [
    "reply_text",
    "intent",
    "needs_human",
    "handoff_reason",
    "language",
    "confidence",
  ],
  additionalProperties: false,
} as const;

const DraftReply = z
  .object({
    reply_text: z.string(),
    intent: z.enum(AI_INTENTS),
    needs_human: z.boolean(),
    handoff_reason: z.string().nullable(),
    language: z.string(),
    confidence: z.enum(AI_CONFIDENCE),
  })
  .strict();

export type GeneratedDraft = {
  replyText: string;
  intent: AiIntent;
  needsHuman: boolean;
  handoffReason: string | null;
  language: string;
  confidence: AiConfidence;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
  };
};

/** A failed draft. `retryable` decides whether the job tries again. */
export class AiGenerationError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "AiGenerationError";
  }
}

/**
 * Typed SDK errors, most specific first (APIConnectionError is a subclass of
 * APIError in TypeScript). 429, 5xx and network failures are retryable; the
 * SDK has already retried them twice inside this attempt.
 */
export function classifyAnthropicError(error: unknown): AiGenerationError {
  if (error instanceof AiGenerationError) return error;
  if (error instanceof Anthropic.APIConnectionError) {
    return new AiGenerationError(`Claude API connection failed: ${error.message}`, true);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AiGenerationError(`Claude API rate limited: ${error.message}`, true);
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new AiGenerationError(
      `Claude API error ${error.status}: ${error.message}`,
      true
    );
  }
  if (error instanceof Anthropic.APIError) {
    return new AiGenerationError(
      `Claude API error ${error.status ?? "-"}${error.type ? ` ${error.type}` : ""}: ${error.message}`,
      false
    );
  }
  return new AiGenerationError(
    error instanceof Error ? error.message : "Unknown error calling Claude",
    false
  );
}

export async function generateDraftReply({
  client,
  model,
  system,
  userMessage,
}: {
  client: AnthropicMessagesClient;
  model: string;
  system: Anthropic.TextBlockParam[];
  userMessage: string;
}): Promise<GeneratedDraft> {
  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model,
      max_tokens: DRAFT_MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: {
        effort: DRAFT_EFFORT,
        format: { type: "json_schema", schema: DRAFT_REPLY_SCHEMA },
      },
      system,
      messages: [{ role: "user", content: userMessage }],
    });
  } catch (error) {
    throw classifyAnthropicError(error);
  }

  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? "uncategorized";
    throw new AiGenerationError(`Claude declined to draft this reply (${category})`, false);
  }
  if (response.stop_reason !== "end_turn") {
    throw new AiGenerationError(
      `Claude stopped before finishing the draft (${response.stop_reason ?? "unknown"})`,
      false
    );
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  let parsed: z.infer<typeof DraftReply>;
  try {
    parsed = DraftReply.parse(JSON.parse(text));
  } catch {
    // Rare with structured outputs; another attempt usually fixes it.
    throw new AiGenerationError("Claude returned a draft in an unexpected format", true);
  }

  const usage = response.usage;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return {
    replyText: parsed.reply_text.trim(),
    intent: parsed.intent,
    needsHuman: parsed.needs_human,
    handoffReason: parsed.handoff_reason?.trim() || null,
    language: parsed.language.trim(),
    confidence: parsed.confidence,
    usage: {
      inputTokens:
        usage.input_tokens + cacheRead + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
      cacheReadTokens: cacheRead,
    },
  };
}

/**
 * Code has the last word on hand-offs, and the reply is cut so that, with
 * the disclosure in front of a first reply, it fits Instagram's 1000 bytes.
 */
export function finalizeDraft(
  draft: GeneratedDraft,
  { disclosureText, firstReply }: { disclosureText: string; firstReply: boolean }
): GeneratedDraft {
  const needsHuman =
    draft.needsHuman ||
    HANDOFF_INTENTS.includes(draft.intent) ||
    draft.confidence === "low";
  const reserved = utf8ByteLength(composeOutgoingText("", disclosureText, firstReply));
  const budget = Math.max(0, MAX_DM_TEXT_BYTES - reserved);
  return {
    ...draft,
    replyText: truncateToUtf8Bytes(draft.replyText, budget).trim(),
    needsHuman,
    handoffReason: needsHuman ? draft.handoffReason : null,
  };
}
