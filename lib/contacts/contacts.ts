import { prisma } from "@/lib/db/client";
import type { Contact } from "@/app/generated/prisma/client";

// How long an unanswered email ask stays open. A product choice, not a Meta
// limit: the person's reply reopens the 24-hour window whenever it comes.
export const EMAIL_GATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Replies without an email that still get an answer. The next one silences
// the gate so a person who will not share an email is not pestered.
export const EMAIL_GATE_MAX_ATTEMPTS = 3;

export type EmailSource = "typed" | "quick_reply";

type ContactKey = {
  workspaceId: string;
  // Internal InstagramAccount.id.
  instagramAccountId: string;
  igsid: string;
  username?: string | null;
};

function contactWhere(instagramAccountId: string, igsid: string) {
  return { instagramAccountId_igsid: { instagramAccountId, igsid } };
}

/**
 * Bookkeeping: note that a campaign matched this person. Never throws — a
 * contacts write must not block or fail the DM it accompanies.
 */
export async function recordContactInteraction({
  workspaceId,
  instagramAccountId,
  igsid,
  username,
}: ContactKey): Promise<void> {
  try {
    const now = new Date();
    await prisma.contact.upsert({
      where: contactWhere(instagramAccountId, igsid),
      create: {
        workspaceId,
        instagramAccountId,
        igsid,
        username: username || null,
        firstSeenAt: now,
        lastInteractionAt: now,
      },
      // A DM job has no username; never blank out one a comment supplied.
      update: { lastInteractionAt: now, ...(username ? { username } : {}) },
    });
  } catch (error) {
    console.error(
      "[Contacts] Failed to record a contact interaction:",
      error instanceof Error ? error.message : error
    );
  }
}

/** The email already stored for this person on this account, if any. */
export async function findKnownEmail(
  instagramAccountId: string,
  igsid: string
): Promise<string | null> {
  const contact = await prisma.contact.findUnique({
    where: contactWhere(instagramAccountId, igsid),
    select: { email: true },
  });
  return contact?.email ?? null;
}

/** The open email gate (if any) for this person on this account. */
export async function findGateState(instagramAccountId: string, igsid: string) {
  return prisma.contact.findUnique({
    where: contactWhere(instagramAccountId, igsid),
    select: {
      pendingEmailAutomationId: true,
      pendingEmailExpiresAt: true,
      pendingEmailSilenced: true,
    },
  });
}

/**
 * Open the email gate for `automationId`. Called only once its ask has gone
 * out, so an open gate always has an ask the person can answer. `prompt` is
 * the exact text sent: it becomes the consent record when an email arrives.
 * Re-opening (another tap, another campaign) replaces any older gate.
 */
export async function openEmailGate({
  workspaceId,
  instagramAccountId,
  igsid,
  username,
  automationId,
  prompt,
}: ContactKey & { automationId: string; prompt: string }): Promise<void> {
  const now = new Date();
  const gate = {
    pendingEmailAutomationId: automationId,
    pendingEmailPrompt: prompt,
    pendingEmailAttempts: 0,
    pendingEmailExpiresAt: new Date(now.getTime() + EMAIL_GATE_TTL_MS),
    pendingEmailSilenced: false,
    lastInteractionAt: now,
  };
  await prisma.contact.upsert({
    where: contactWhere(instagramAccountId, igsid),
    create: {
      workspaceId,
      instagramAccountId,
      igsid,
      username: username || null,
      firstSeenAt: now,
      ...gate,
    },
    update: { ...(username ? { username } : {}), ...gate },
  });
}

/** The contact who sent an inbound DM, on the account that received it. */
export async function findMessageContact({
  instagramId,
  accountConnectionId,
  igsid,
}: {
  instagramId: string;
  accountConnectionId?: string;
  igsid: string;
}): Promise<Contact | null> {
  return prisma.contact.findFirst({
    where: {
      igsid,
      instagramAccount: { instagramId },
      ...(accountConnectionId ? { instagramAccountId: accountConnectionId } : {}),
    },
  });
}

// Every gate write below is a compare-and-set on the gate as it was read:
// the same campaign and the same expiry (which is unique per opening). Two
// messages handled at once, or a gate re-opened meanwhile, therefore cannot
// overwrite each other — the loser's write matches nothing.
function sameGate(contact: Contact) {
  return {
    id: contact.id,
    pendingEmailAutomationId: contact.pendingEmailAutomationId,
    pendingEmailExpiresAt: contact.pendingEmailExpiresAt,
  };
}

/**
 * Store the captured email while the gate is still open and no email is
 * stored yet. Returns false when another message got there first.
 */
export async function storeCapturedEmail(
  contact: Contact,
  { email, source }: { email: string; source: EmailSource }
): Promise<boolean> {
  const now = new Date();
  const result = await prisma.contact.updateMany({
    where: { ...sameGate(contact), email: null },
    data: {
      email,
      emailSource: source,
      emailCapturedAt: now,
      emailAutomationId: contact.pendingEmailAutomationId,
      emailConsentText: contact.pendingEmailPrompt,
      lastInteractionAt: now,
    },
  });
  return result.count === 1;
}

/**
 * Count one reply without an email. Returns the new count, or null when the
 * gate changed meanwhile (that message is then left alone).
 */
export async function recordFailedEmailAttempt(
  contact: Contact
): Promise<{ attempts: number; silenced: boolean } | null> {
  const attempts = contact.pendingEmailAttempts + 1;
  const silenced = attempts > EMAIL_GATE_MAX_ATTEMPTS;
  const result = await prisma.contact.updateMany({
    where: {
      ...sameGate(contact),
      pendingEmailAttempts: contact.pendingEmailAttempts,
      pendingEmailSilenced: false,
    },
    data: {
      pendingEmailAttempts: attempts,
      pendingEmailSilenced: silenced,
      lastInteractionAt: new Date(),
    },
  });
  return result.count === 1 ? { attempts, silenced } : null;
}

export async function clearEmailGate(contact: Contact): Promise<void> {
  await prisma.contact.updateMany({
    where: sameGate(contact),
    data: {
      pendingEmailAutomationId: null,
      pendingEmailPrompt: null,
      pendingEmailAttempts: 0,
      pendingEmailExpiresAt: null,
      pendingEmailSilenced: false,
    },
  });
}

export async function reloadContact(id: string): Promise<Contact | null> {
  return prisma.contact.findUnique({ where: { id } });
}

// Durable one-time markers, stored as PostbackDelivery rows (the same table
// the worker's button-tap claims use): they outlive BullMQ's job retention,
// which matters because Meta redelivers a webhook for up to 36 hours.
export async function claimOnce(id: string): Promise<boolean> {
  try {
    await prisma.postbackDelivery.create({ data: { id } });
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    )
      return false;
    throw error;
  }
}

export async function isClaimed(id: string): Promise<boolean> {
  const claim = await prisma.postbackDelivery.findUnique({ where: { id } });
  return Boolean(claim);
}
