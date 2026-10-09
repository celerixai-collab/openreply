import { z } from "zod";
import { MAX_DM_TEXT_BYTES, utf8ByteLength } from "@/lib/contacts/email-copy";

// The email gate's campaign settings, shared by the create and update schemas
// in app/api/automations/route.ts. Instagram's limit is 1000 UTF-8 bytes (only
// ~333 Chinese characters), so that is what is checked, not characters: text
// over it is refused rather than saved and then cut from the end, which is
// where an ask's purpose and opt-out notice usually sit. The worker still
// truncates, for what {username} / {email} add when it renders.
const emailGateMessage = z
  .string()
  .max(1000)
  .refine((text) => utf8ByteLength(text) <= MAX_DM_TEXT_BYTES, {
    message: `Email gate messages must be at most ${MAX_DM_TEXT_BYTES} bytes`,
  })
  .optional()
  .nullable();

export const createEmailGateFields = {
  collectEmail: z.boolean().optional().default(false),
  emailPromptMessage: emailGateMessage,
  emailInvalidMessage: emailGateMessage,
  emailThanksMessage: emailGateMessage,
  emailQuickReplyEnabled: z.boolean().optional().default(true),
};

export const updateEmailGateFields = {
  collectEmail: z.boolean().optional(),
  emailPromptMessage: emailGateMessage,
  emailInvalidMessage: emailGateMessage,
  emailThanksMessage: emailGateMessage,
  emailQuickReplyEnabled: z.boolean().optional(),
};

type EmailGateMessages = {
  emailPromptMessage?: string | null;
  emailInvalidMessage?: string | null;
  emailThanksMessage?: string | null;
};

const MESSAGE_FIELDS = [
  "emailPromptMessage",
  "emailInvalidMessage",
  "emailThanksMessage",
] as const;

// An empty message means "use the default copy", which the worker reads as
// null, so blank and whitespace-only text is stored as null.
function blankToNull(value: string | null | undefined): string | null {
  return value?.trim() ? value.trim() : null;
}

/** The email gate columns for a new campaign. */
export function emailGateCreateData(
  data: EmailGateMessages & {
    collectEmail: boolean;
    emailQuickReplyEnabled: boolean;
  }
) {
  const { collectEmail } = data;
  return {
    collectEmail,
    // Like the follow prompt, custom copy is kept only while the gate is on.
    emailPromptMessage: collectEmail ? blankToNull(data.emailPromptMessage) : null,
    emailInvalidMessage: collectEmail
      ? blankToNull(data.emailInvalidMessage)
      : null,
    emailThanksMessage: collectEmail ? blankToNull(data.emailThanksMessage) : null,
    emailQuickReplyEnabled: data.emailQuickReplyEnabled,
  };
}

/**
 * Normalize a PATCH in place: blank messages become null, and turning the
 * gate off clears its copy (the same rule as the follow prompt). Fields the
 * request leaves out stay undefined, so Prisma leaves them unchanged.
 */
export function normalizeEmailGateUpdate(
  data: EmailGateMessages & { collectEmail?: boolean }
): void {
  for (const field of MESSAGE_FIELDS) {
    if (data[field] !== undefined) data[field] = blankToNull(data[field]);
  }
  if (data.collectEmail === false) {
    for (const field of MESSAGE_FIELDS) data[field] = null;
  }
}
