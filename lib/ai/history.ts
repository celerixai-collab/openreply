import {
  findConversationWithUser,
  getConversationMessages,
} from "@/lib/meta/client";
import { extractEmail } from "@/lib/utils/email";
import type { HistoryTurn } from "./prompt";

// Same placeholder the worker logs for a DM that carries an email: the model
// never sees an address, and none is stored with a draft.
export const MASKED_EMAIL_TEXT = "(message with an email)";
// Meta returns full details for the 20 most recent messages only.
export const HISTORY_LIMIT = 20;

export function maskEmails(text: string): string {
  return extractEmail(text) ? MASKED_EMAIL_TEXT : text;
}

export type LoadedTurn = HistoryTurn & { id: string };

/**
 * The conversation with one person, oldest first, from the Conversations API:
 * it includes the creator's own replies typed in the Instagram app and every
 * automated message, which webhooks never show us. Throws on any API error;
 * the caller falls back to the messages it already has.
 */
export async function loadConversationHistory({
  accessToken,
  igUserId,
  igsid,
}: {
  accessToken: string;
  igUserId: string;
  igsid: string;
}): Promise<{ turns: LoadedTurn[]; username: string | null }> {
  const conversationId = await findConversationWithUser(accessToken, igUserId, igsid);
  if (!conversationId) return { turns: [], username: null };

  const messages = await getConversationMessages(accessToken, conversationId);
  let username: string | null = null;
  const turns: LoadedTurn[] = [];
  for (const message of messages.slice(0, HISTORY_LIMIT)) {
    const fromPerson = message.from?.id === igsid;
    if (fromPerson && message.from?.username) username = message.from.username;
    const text = message.message?.trim();
    turns.push({
      id: message.id,
      from: fromPerson ? "person" : "creator",
      text: text ? maskEmails(text) : "(attachment or non-text message)",
      at: message.created_time ? toIso(message.created_time) : null,
    });
  }
  // Meta lists newest first.
  turns.reverse();
  return { turns, username };
}

function toIso(value: string): string | null {
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
