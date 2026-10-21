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

