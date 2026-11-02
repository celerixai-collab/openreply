/**
 * One-time rescue, run by the worker at start-up: comments whose private
 * reply Instagram throttled (code 100 / subcode 2534001, "thread does not
 * exist") and that the old worker gave up on after three quick retries.
 * Nothing was delivered to them and Instagram still allows the private reply
 * (7 days from the comment), so they go back to the reconciler, which now
 * sends them at the paced rate. Runs in the worker, not as a migration, so
 * the old worker never sees the reset rows; the claim makes it run once.
 */

import { prisma } from "@/lib/db/client";
import { claimOnce } from "@/lib/contacts/contacts";
import { getDMQueue, POSTBACK_JOB_NAME } from "@/lib/queue/client";

// The two "剪輯室 早鳥等候" campaigns of 2026-10-20.
const CAMPAIGN_IDS = ["cmvgv55ce000208l5mzi3maff", "cmvgv5uv6000307jybnpiejoe"];
const RUN_ID = "requeue-throttled-2026-10-20";
// A little under Instagram's 7 days, so nothing is reset that can no longer
// be sent.
const MAX_AGE_MS = 6.5 * 24 * 60 * 60 * 1000;

export async function requeueThrottledComments(): Promise<number> {
  if (!(await claimOnce(RUN_ID))) return 0;
  const { count } = await prisma.dmLog.updateMany({
    where: {
      automationId: { in: CAMPAIGN_IDS },
      status: "FAILED",
      NOT: { commentId: { startsWith: "reveal:" } },
      errorMessage: { contains: "thread does not exist" },
      createdAt: { gt: new Date(Date.now() - MAX_AGE_MS) },
    },
    data: {
      status: "PENDING",
      attempts: 0,
      dmDeliveryUnconfirmed: false,
      errorMessage: "Re-queued after Instagram throttling on 2026-10-20",
    },
  });
  console.log(`[DM Worker] Re-queued ${count} throttled comments for a paced re-send`);
  return count;
}

/**
 * One-time undo of the short-lived "one DM per person" rule (2026-10-20):
 * every comment gets its campaign's DM again, as upstream OpenReply does, so
 * comments skipped under that rule go back to the reconciler.
 */
export async function requeuePersonDedupSkips(): Promise<number> {
  if (!(await claimOnce("requeue-person-dedup-2026-10-21"))) return 0;
  const { count } = await prisma.dmLog.updateMany({
    where: {
      status: "SKIPPED_DEDUP",
      errorMessage: "This person already got this campaign's DM for an earlier comment",
      createdAt: { gt: new Date(Date.now() - MAX_AGE_MS) },
    },
    data: { status: "PENDING", attempts: 0, dmDeliveryUnconfirmed: false, errorMessage: null },
  });
  console.log(`[DM Worker] Re-queued ${count} comments skipped as repeat comments`);
  return count;
}

/**
 * One-time fix (2026-10-21): six private replies in the two campaigns were
 * cut off mid-send by redeploys and, when retried, Instagram answered
 * "unknown error", as it does for a second private reply to the same
 * comment. They are taken as delivered, so each comment also gets its public
 * reply.
 */
export async function markRefusedRepeatsDelivered(): Promise<number> {
  if (!(await claimOnce("mark-refused-repeats-2026-10-21"))) return 0;
  const { count } = await prisma.dmLog.updateMany({
    where: {
      automationId: { in: CAMPAIGN_IDS },
      status: "FAILED",
      dmDeliveryUnconfirmed: true,
      attempts: { gte: 2 },
      NOT: { commentId: { startsWith: "reveal:" } },
    },
    data: {
      status: "SENT",
      dmDeliveryUnconfirmed: false,
      errorMessage:
        "Taken as delivered: a retry was refused as Instagram does for a second private reply",
    },
  });
  console.log(`[DM Worker] Marked ${count} refused repeat private replies as delivered`);
  return count;
}

/**
 * One-time rescue (2026-10-21) for every other campaign: comments from the
 * night of 2026-10-20 whose private reply Instagram throttled and the old
 * worker gave up on. They go back to the reconciler, which sends them at
 * the paced rate. Accounts that "cannot be found" are left out: nothing can
 * reach them.
 */
export async function requeueThrottledEverywhere(): Promise<number> {
  if (!(await claimOnce("requeue-throttled-all-2026-10-21"))) return 0;
  const { count } = await prisma.dmLog.updateMany({
    where: {
      status: "FAILED",
      NOT: { commentId: { startsWith: "reveal:" } },
      errorMessage: { contains: "thread does not exist" },
      createdAt: { gt: new Date(Date.now() - MAX_AGE_MS) },
    },
    data: {
      status: "PENDING",
      attempts: 0,
      dmDeliveryUnconfirmed: false,
      errorMessage: "Re-queued after Instagram throttling on 2026-10-20",
    },
  });
  console.log(`[DM Worker] Re-queued ${count} throttled comments in other campaigns`);
  return count;
}

/**
 * After a reconnect: comments that failed only because the Instagram token had
 * run out go back to the reconciler, DM and public reply both, at the paced
 * rate. Nothing was delivered to them. Started by hand, since it can be a large
 * batch of public replies.
 */
export async function requeueExpiredTokenComments(workspaceId: string): Promise<number> {
  const { count } = await prisma.dmLog.updateMany({
    where: {
      workspaceId,
      status: "FAILED",
      publicReplySentAt: null,
      NOT: { commentId: { startsWith: "reveal:" } },
      OR: [
        { errorMessage: { contains: "Session has expired" } },
        { errorMessage: { contains: "Error validating access token" } },
      ],
      createdAt: { gt: new Date(Date.now() - MAX_AGE_MS) },
    },
    data: {
      status: "PENDING",
      attempts: 0,
      dmDeliveryUnconfirmed: false,
      publicReplyDeliveryUnconfirmed: false,
      publicReplyError: null,
      errorMessage: null,
    },
  });
  console.log(`[DM Worker] Re-queued ${count} comments that failed on an expired token`);
  return count;
}

/**
 * Comments that got their public reply while the DM's delivery was left
 * unconfirmed. Safe to send again: Instagram allows one private reply per
 * comment, so a repeat either delivers the lost one or is refused.
 */
export async function requeueUnconfirmedDms(workspaceId: string): Promise<number> {
  const { count } = await prisma.dmLog.updateMany({
    where: {
      workspaceId,
      status: "FAILED",
      publicReplySentAt: { not: null },
      NOT: { commentId: { startsWith: "reveal:" } },
      errorMessage: { contains: "delivery is unconfirmed" },
      createdAt: { gt: new Date(Date.now() - MAX_AGE_MS) },
    },
    data: { status: "PENDING", attempts: 0, dmDeliveryUnconfirmed: false, errorMessage: null },
  });
  console.log(`[DM Worker] Re-queued ${count} replied-to comments whose DM was unconfirmed`);
  return count;
}

/** How many comments the re-queues above would pick up, for the Diagnostics page. */
export async function countRecoverableComments(workspaceId: string): Promise<number> {
  return prisma.dmLog.count({
    where: {
      workspaceId,
      status: "FAILED",
      NOT: { commentId: { startsWith: "reveal:" } },
      OR: [
        { errorMessage: { contains: "Session has expired" } },
        { errorMessage: { contains: "Error validating access token" } },
        { publicReplySentAt: { not: null }, errorMessage: { contains: "delivery is unconfirmed" } },
      ],
      createdAt: { gt: new Date(Date.now() - MAX_AGE_MS) },
    },
  });
}

// Instagram's 24-hour window after a button tap, with a margin.
const TAP_WINDOW_MS = 23 * 60 * 60 * 1000;

/**
 * Button taps from the last day whose link failed on an expired token. Older
 * taps are outside the window Instagram allows, so they wait for the next tap.
 */
export async function requeueExpiredTokenTaps(workspaceId: string): Promise<number> {
  const taps = await prisma.dmLog.findMany({
    where: {
      workspaceId,
      status: "FAILED",
      commentId: { startsWith: "reveal:" },
      errorMessage: { contains: "Session has expired" },
      updatedAt: { gt: new Date(Date.now() - TAP_WINDOW_MS) },
    },
    select: {
      id: true,
      automationId: true,
      commenterId: true,
      automation: {
        select: { instagramAccountId: true, instagramAccount: { select: { instagramId: true } } },
      },
    },
  });
  for (const tap of taps) {
    await getDMQueue().add(
      POSTBACK_JOB_NAME,
      {
        accountConnectionId: tap.automation.instagramAccountId,
        instagramAccountId: tap.automation.instagramAccount.instagramId,
        userId: tap.commenterId,
        payload: `reveal:${tap.automationId}`,
        mid: `token-rescue:${tap.id}`,
      },
      { jobId: `token-rescue_${tap.id}` }
    );
  }
  console.log(`[DM Worker] Re-queued ${taps.length} button taps that failed on an expired token`);
  return taps.length;
}
