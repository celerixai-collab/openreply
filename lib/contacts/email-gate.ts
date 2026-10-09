import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/client";
import type { Contact } from "@/app/generated/prisma/client";
import { isConfirmedSendRejection } from "@/lib/instagram/delivery-errors";
import {
  createInstagramContext,
  hasInstagramCredentials,
  sendDirectMessage,
  sendDirectMessageWithEmailQuickReply,
  supportsEmailQuickReply,
  type InstagramContext,
} from "@/lib/instagram/provider";
import type { ProcessMessageJob } from "@/lib/queue/client";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import { renderMessageWithoutLink } from "@/lib/tracking/message";
import { extractEmail, looksLikeEmailAttempt } from "@/lib/utils/email";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import {
  claimOnce,
  clearEmailGate,
  findGateState,
  findKnownEmail,
  findMessageContact,
  isClaimed,
  openEmailGate,
  recordFailedEmailAttempt,
  reloadContact,
  storeCapturedEmail,
} from "./contacts";
import {
  DEFAULT_EMAIL_INVALID_MESSAGE,
  DEFAULT_EMAIL_THANKS_MESSAGE,
  defaultEmailPrompt,
  truncateToUtf8Bytes,
} from "./email-copy";

/**
 * Email gate: a campaign with `collectEmail` delivers its link only to someone
 * who has left an email. The worker calls in at three points, always after
 * the opening DM and the follow gate and before the link:
 *
 * - a comment with no opening DM and no follow prompt: the private reply
 *   itself is the ask (the person's typed reply opens the 24h window);
 * - a button tap (reveal / follow check): the ask goes out as a DM;
 * - a DM keyword trigger: the ask replaces the link.
 *
 * Every inbound DM first passes `handleEmailGateReply`, which answers the
 * open gate (if any) before the keyword campaigns see the message.
 */

type GateCopy = {
  emailPromptMessage?: string | null;
  emailInvalidMessage?: string | null;
  emailThanksMessage?: string | null;
  emailQuickReplyEnabled?: boolean | null;
};

type GateAutomation = GateCopy & {
  id: string;
  workspaceId: string;
  instagramAccountId: string;
  instagramAccount: { instagramId: string };
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

// Every gate message is personalized, then held to Instagram's byte limit.
function renderGateText(
  message: string,
  commenterName: string | null | undefined,
  email?: string
): string {
  return truncateToUtf8Bytes(
    renderMessageWithoutLink({ message, commenterName, email })
  );
}

/** Whether a DM from this campaign carries the one-tap email button. */
export function offersEmailQuickReply(
  automation: GateCopy,
  context: InstagramContext
): boolean {
  return (
    automation.emailQuickReplyEnabled !== false &&
    supportsEmailQuickReply(context)
  );
}

export function buildEmailAsk(
  automation: GateCopy,
  commenterName: string | null | undefined,
  withQuickReply: boolean
): string {
  return renderGateText(
    automation.emailPromptMessage?.trim() || defaultEmailPrompt(withQuickReply),
    commenterName
  );
}

function buildEmailInvalid(
  automation: GateCopy,
  commenterName: string | null | undefined
): string {
  return renderGateText(
    automation.emailInvalidMessage?.trim() || DEFAULT_EMAIL_INVALID_MESSAGE,
    commenterName
  );
}

function buildEmailThanks(
  automation: GateCopy,
  commenterName: string | null | undefined,
  email: string
): string {
  return renderGateText(
    automation.emailThanksMessage?.trim() || DEFAULT_EMAIL_THANKS_MESSAGE,
    commenterName,
    email
  );
}

/**
 * Whether `igsid` still has to leave an email before `automation` hands over
 * its link. A known email (on this Instagram account) skips the ask entirely.
 */
export async function emailStillNeeded(
  automation: { collectEmail?: boolean | null; instagramAccountId: string },
  igsid: string
): Promise<boolean> {
  if (!automation.collectEmail) return false;
  return !(await findKnownEmail(automation.instagramAccountId, igsid));
}

/** Send gate text as a DM, with the one-tap email button when offered. */
export function sendEmailGateMessage({
  context,
  automation,
  userId,
  message,
}: {
  context: InstagramContext;
  automation: GateAutomation;
  userId: string;
  message: string;
}) {
  const args = {
    context,
    instagramAccountId: automation.instagramAccount.instagramId,
    userId,
    message,
  };
  return offersEmailQuickReply(automation, context)
    ? sendDirectMessageWithEmailQuickReply(args)
    : sendDirectMessage(args);
}

/**
 * Start the gate: `send` delivers the ask (`prompt`, exactly as sent), and
 * only then is the gate opened. A send rejected outright leaves it closed, so
 * no reply is ever read as an answer to an ask that never arrived. A send
 * whose outcome is unknown opens it too: Meta often delivers those, and the
 * person's emailed reply would otherwise be ignored. `send` may answer false
 * (a button tap's ask that already went out), which opens nothing new.
 */
export async function startEmailGate({
  automation,
  igsid,
  username,
  prompt,
  send,
}: {
  automation: GateAutomation;
  igsid: string;
  username: string | null | undefined;
  prompt: string;
  send: () => Promise<unknown>;
}): Promise<void> {
  const open = () =>
    openEmailGate({
      workspaceId: automation.workspaceId,
      instagramAccountId: automation.instagramAccountId,
      igsid,
      username,
      automationId: automation.id,
      prompt,
    });

  let sent: unknown;
  try {
    sent = await send();
  } catch (error) {
    if (!isConfirmedSendRejection(error)) {
      await open().catch((openError) =>
        console.error(
          "[Email gate] Failed to open the gate after an unconfirmed ask:",
          describeError(openError)
        )
      );
    }
    throw error;
  }
  if (sent === false) return;
  await open();
}

function loadGateAutomation(automationId: string, accountConnectionId?: string) {
  return prisma.automation.findFirst({
    where: {
      id: automationId,
      isActive: true,
      ...(accountConnectionId ? { instagramAccountId: accountConnectionId } : {}),
    },
    include: {
      instagramAccount: true,
      trackedLinks: {
        select: { slug: true, label: true, destinationUrl: true },
        orderBy: TRACKED_LINK_ORDER,
      },
    },
  });
}

export type GateDeliveryAutomation = NonNullable<
  Awaited<ReturnType<typeof loadGateAutomation>>
>;

/**
 * What a reveal delivery did. Only "sent" means this call delivered the link;
 * "already_claimed" means another attempt holds its claim (it sent the link,
 * or is sending it right now), "plan_limit" that the monthly DM limit held it
 * back, and "not_sent" a read fallback the closed window turned away.
 */
export type LinkDelivery = "sent" | "already_claimed" | "plan_limit" | "not_sent";

// What the gate needs from the worker: its durable one-send claim and its
// reveal delivery, so a captured email gets the link exactly the way a
// button tap does (usage, claims, follow-up, logs).
export type EmailGateDeps = {
  sendOnce: (args: {
    operationId: string;
    send: () => Promise<unknown>;
  }) => Promise<boolean>;
  deliverLink: (args: {
    automation: GateDeliveryAutomation;
    accessToken: InstagramContext;
    userId: string;
    commenterName: string | null;
    operationId: string;
    commentText: string;
    // Runs right before the link is sent, once usage is reserved. Must not
    // throw.
    beforeLink?: () => Promise<void>;
  }) => Promise<LinkDelivery>;
};

type InboundMessage = Pick<
  ProcessMessageJob,
  | "instagramAccountId"
  | "accountConnectionId"
  | "messageId"
  | "messageText"
  | "senderId"
  | "fromQuickReply"
>;

type KeywordCampaign = {
  id: string;
  keywords: string[];
  wholeWordMatch: boolean;
  matchAnyWord: boolean;
};

function claimId(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// One opening of a gate. The expiry is set fresh on every opening, so a
// re-opened gate gets new thanks / delivery claims.
function gateInstance(contact: Contact): string {
  return `${contact.pendingEmailAutomationId}:${contact.pendingEmailExpiresAt?.toISOString()}`;
}

function triggerClaim(instagramAccountId: string, messageId: string): string {
  return claimId("email-gate-trigger", instagramAccountId, messageId);
}

/**
 * Mark an inbound DM as the keyword trigger that asked for an email. The
 * gate it opens must not read that same message as its first answer when
 * it is redelivered or its job is retried: it belongs to the keyword
 * campaigns, whose own `dm:<mid>` dedupe decides what is left to send.
 */
export async function markEmailGateTrigger(
  instagramAccountId: string,
  messageId: string
): Promise<void> {
  await claimOnce(triggerClaim(instagramAccountId, messageId));
}

/**
 * Whether this person went quiet on `automation`'s own ask: its gate is
 * still open (unexpired) for them but silenced after too many replies
 * without an email.
 */
export async function emailGateSilencedFor(
  automation: { id: string; instagramAccountId: string },
  igsid: string
): Promise<boolean> {
  const contact = await findGateState(automation.instagramAccountId, igsid);
  return Boolean(
    contact?.pendingEmailSilenced &&
      contact.pendingEmailAutomationId === automation.id &&
      contact.pendingEmailExpiresAt &&
      contact.pendingEmailExpiresAt.getTime() > Date.now()
  );
}

/**
 * The inbound-DM step that runs BEFORE the keyword campaigns. Returns true
 * when the message belonged to the email gate (stop), false to hand it on.
 *
 * With an open gate for an active campaign that still collects email:
 * 1. an email in the text is stored, thanked once and answered with that
 *    campaign's link; the gate closes once the link went out;
 * 2. otherwise, another DM campaign's keyword (never a match-any-word
 *    campaign, which would match every reply) closes the gate and hands on;
 * 3. otherwise the reply is counted: up to 3 get a re-prompt, the next one
 *    silences the gate. A silenced gate hands every later message on.
 * The email is looked for first because the keyword matcher splits
 * "link@gmail.com" into words, so an email reply can contain a keyword.
 *
 * Safe against Meta's redeliveries (up to 36h) and BullMQ concurrency: each
 * message is marked as the gate's, every gate write is a compare-and-set, and
 * the thanks and the link each have one durable claim per gate opening.
 */
export async function handleEmailGateReply({
  message,
  operationId,
  keywordCampaigns,
  deps,
}: {
  message: InboundMessage;
  operationId: string;
  keywordCampaigns: KeywordCampaign[];
  deps: EmailGateDeps;
}): Promise<boolean> {
  const contact = await findMessageContact({
    instagramId: message.instagramAccountId,
    accountConnectionId: message.accountConnectionId,
    igsid: message.senderId,
  });
  if (!contact) return false;

  const messageClaim = claimId(
    "email-gate-message",
    contact.instagramAccountId,
    message.messageId
  );
  // A redelivered message the gate already consumed must not reach the
  // keyword campaigns just because the gate has closed since.
  const handledEarlier = async () =>
    Boolean(contact.pendingEmailAutomationId || contact.emailCapturedAt) &&
    (await isClaimed(messageClaim));

  if (!contact.pendingEmailAutomationId) return handledEarlier();

  // The message that opened this gate (a DM keyword trigger) is never its
  // answer: hand it back to the keyword loop, which dedupes it.
  if (await isClaimed(triggerClaim(contact.instagramAccountId, message.messageId))) {
    return false;
  }

  if (
    !contact.pendingEmailExpiresAt ||
    contact.pendingEmailExpiresAt.getTime() <= Date.now()
  ) {
    await clearEmailGate(contact);
    return handledEarlier();
  }
  if (contact.pendingEmailSilenced) return handledEarlier();

  const automation = await loadGateAutomation(
    contact.pendingEmailAutomationId,
    message.accountConnectionId
  );
  if (
    !automation ||
    !automation.collectEmail ||
    automation.instagramAccount.instagramId !== message.instagramAccountId
  ) {
    await clearEmailGate(contact);
    return handledEarlier();
  }
  // Disconnected account: nothing can be sent now. Keep the gate open for
  // when it is reconnected and let the keyword campaigns log the failure.
  if (!hasInstagramCredentials(automation.instagramAccount)) {
    return handledEarlier();
  }

  // An email already stored under an open gate is a capture whose delivery
  // did not finish (a retry, or a second message racing the first): finish
  // it, whatever this message says. But once another attempt holds the
  // link's claim (it sent the link, is sending it, or ended unconfirmed),
  // there is nothing left to finish: a new message then goes on to the
  // keyword campaigns instead of being swallowed by the gate.
  if (
    contact.email &&
    (await isClaimed(claimId("email-reveal", contact.id, gateInstance(contact))))
  ) {
    return isClaimed(messageClaim);
  }
  const email = contact.email ?? extractEmail(message.messageText);
  if (email) {
    await completeEmailCapture({
      contact,
      automation,
      email,
      message,
      messageClaim,
      operationId,
      deps,
    });
    return true;
  }

  const movedOn = keywordCampaigns.some(
    (campaign) =>
      campaign.id !== automation.id &&
      !campaign.matchAnyWord &&
      matchKeywords(message.messageText, campaign.keywords, campaign.wholeWordMatch)
        .matched
  );
  if (movedOn) {
    await clearEmailGate(contact);
    return false;
  }

  // Count each message once, however often it is redelivered.
  if (!(await claimOnce(messageClaim))) return true;
  await answerWithoutEmail({ contact, automation, message, operationId });
  return true;
}

async function completeEmailCapture({
  contact,
  automation,
  email,
  message,
  messageClaim,
  operationId,
  deps,
}: {
  contact: Contact;
  automation: GateDeliveryAutomation;
  email: string;
  message: InboundMessage;
  messageClaim: string;
  operationId: string;
  deps: EmailGateDeps;
}): Promise<void> {
  // Marked first: if delivery fails below, the gate stays open, so a retry
  // of this job still finishes the capture.
  await claimOnce(messageClaim);

  let storedEmail = email;
  if (!contact.email) {
    const stored = await storeCapturedEmail(contact, {
      email,
      source: message.fromQuickReply ? "quick_reply" : "typed",
    });
    if (!stored) {
      // Another message stored an email first. Finish its capture if this
      // gate is still the open one; if it closed, that message delivered.
      const fresh = await reloadContact(contact.id);
      if (!fresh?.email || gateInstance(fresh) !== gateInstance(contact)) {
        return;
      }
      storedEmail = fresh.email;
    }
  }

  const accessToken = await createInstagramContext(
    automation.instagramAccount,
    operationId
  );
  const gate = gateInstance(contact);

  // Best-effort and once per gate: a thanks that fails must not hold back
  // the link, and a retry after a failed link must not thank twice. It runs
  // inside the delivery, after usage is reserved, so it never promises a
  // link the monthly limit then holds back.
  const sendThanks = async () => {
    try {
      await deps.sendOnce({
        operationId: claimId("email-thanks", contact.id, gate),
        send: () =>
          sendDirectMessage({
            context: accessToken,
            instagramAccountId: automation.instagramAccount.instagramId,
            userId: message.senderId,
            message: buildEmailThanks(automation, contact.username, storedEmail),
          }),
      });
    } catch (error) {
      console.log("[Email gate] Thanks message not sent:", describeError(error));
    }
  };

  // Throws when the link could not be sent; the gate then stays open (with
  // the email stored) and the retry — or the person's next message —
  // delivers it. The gate closes only when this call sent the link: a claim
  // held elsewhere belongs to an attempt that closes it itself once its send
  // succeeds (and may yet fail and retry), and a monthly limit leaves it open
  // so the person's next message, once the limit resets, gets the link.
  const delivery = await deps.deliverLink({
    automation,
    accessToken,
    userId: message.senderId,
    commenterName: contact.username,
    operationId: claimId("email-reveal", contact.id, gate),
    commentText: "(email reply)",
    beforeLink: sendThanks,
  });
  if (delivery === "sent") await clearEmailGate(contact);
}

async function answerWithoutEmail({
  contact,
  automation,
  message,
  operationId,
}: {
  contact: Contact;
  automation: GateDeliveryAutomation;
  message: InboundMessage;
  operationId: string;
}): Promise<void> {
  const counted = await recordFailedEmailAttempt(contact);
  if (!counted || counted.silenced) return;

  // Best-effort: if the re-prompt cannot be sent the gate stays open and the
  // person can simply reply again.
  try {
    const accessToken = await createInstagramContext(
      automation.instagramAccount,
      operationId
    );
    const text = looksLikeEmailAttempt(message.messageText)
      ? buildEmailInvalid(automation, contact.username)
      : buildEmailAsk(
          automation,
          contact.username,
          offersEmailQuickReply(automation, accessToken)
        );
    await sendEmailGateMessage({
      context: accessToken,
      automation,
      userId: message.senderId,
      message: text,
    });
  } catch (error) {
    console.log("[Email gate] Re-prompt not sent:", describeError(error));
  }
}
