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
import { getDMQueue } from "@/lib/queue/client";
import { SCHEDULED_RETRY_MARK } from "@/lib/queue/comment-delivery";
import { restartPaceLine } from "@/lib/utils/rate-limiter";

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
 * Comments that failed only because the Instagram token had
 * run out go back to the reconciler, DM and public reply both, at the paced
 * rate. Nothing was delivered to them.
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
  return count;
}

/**
 * Comments that got their public reply while the DM's delivery was left
 * unconfirmed go back to the reconciler, once each. Safe to send again: Instagram
 * allows one private reply per comment, so a repeat either delivers the lost one
 * or is refused.
 */
export async function requeueUnconfirmedDms(workspaceId: string): Promise<number> {
  const rows = await prisma.dmLog.findMany({
    where: {
      workspaceId,
      status: "FAILED",
      publicReplySentAt: { not: null },
      NOT: { commentId: { startsWith: "reveal:" } },
      errorMessage: { contains: "delivery is unconfirmed" },
      createdAt: { gt: new Date(Date.now() - MAX_AGE_MS) },
    },
    select: { id: true },
  });
  let count = 0;
  for (const { id } of rows) {
    if (!(await claimOnce(`auto-resend:${id}`))) continue;
    await prisma.dmLog.update({
      where: { id },
      data: { status: "PENDING", attempts: 0, dmDeliveryUnconfirmed: false, errorMessage: null },
    });
    count += 1;
  }
  return count;
}

/**
 * Run at every start: a waiting comment needs one job for its DM and at most one
 * for its public reply. Copies stretch everyone's wait, since waiting jobs are
 * spread over more minutes. The copy that wakes first stays.
 */
export async function removeDuplicateDelayedComments(): Promise<number> {
  const jobs = await getDMQueue().getDelayed(0, -1);
  jobs.sort((a, b) => a.timestamp + a.delay - (b.timestamp + b.delay));
  const seen = new Set<string>();
  let removed = 0;
  for (const job of jobs) {
    if (job.name !== "process-comment" || !("commentId" in job.data)) continue;
    const key = `${job.data.commentId}:${job.id?.endsWith("_pub") ? "public" : "dm"}`;
    if (seen.has(key)) {
      await job.remove();
      removed += 1;
    } else {
      seen.add(key);
    }
  }
  if (removed > 0) console.log(`[DM Worker] Removed ${removed} duplicate waiting jobs, kept ${seen.size}`);
  return removed;
}

/**
 * Run at every start: sending times are handed out when a comment joins the line,
 * so without this a changed DM_PACE_PER_MINUTE would not reach the comments
 * already waiting. Oldest place first.
 */
export async function respaceWaitingComments(): Promise<number> {
  const jobs = await getDMQueue().getDelayed(0, -1);
  const lines = new Map<string, typeof jobs>();
  for (const job of jobs) {
    if (
      job.name !== "process-comment" ||
      !("paceSlotAt" in job.data) ||
      job.data.paceSlotAt === undefined ||
      job.data.liveLine ||
      job.id?.endsWith("_pub")
    ) {
      continue;
    }
    const line = lines.get(job.data.instagramAccountId) ?? [];
    line.push(job);
    lines.set(job.data.instagramAccountId, line);
  }
  let moved = 0;
  for (const [instagramAccountId, line] of lines) {
    line.sort((a, b) => ("paceSlotAt" in a.data && "paceSlotAt" in b.data ? a.data.paceSlotAt! - b.data.paceSlotAt! : 0));
    const times = await restartPaceLine(instagramAccountId, line.length);
    for (const [i, job] of line.entries()) {
      try {
        await job.updateData({ ...job.data, paceSlotAt: times[i] } as never);
        await job.changeDelay(times[i] - Date.now());
        moved += 1;
      } catch {
        // It started running in the meantime.
      }
    }
  }
  if (moved > 0) console.log(`[DM Worker] Gave ${moved} waiting comments new sending times`);
  return moved;
}

/**
 * A comment marked as having a job waiting is skipped by the sweep, so one whose
 * job is gone would sit unsent. Clearing the mark hands it back to the sweep; a
 * job missed by accident only costs one more, which the delivery claim stops.
 */
export async function clearOrphanedRetryMarks(): Promise<number> {
  const queue = getDMQueue();
  // In the order jobs move through, so one changing state is still seen.
  const jobs = [
    ...(await queue.getDelayed(0, -1)),
    ...(await queue.getWaiting(0, -1)),
    ...(await queue.getActive(0, -1)),
  ];
  const owned = new Set<string>();
  for (const job of jobs) {
    if (job.name === "process-comment" && "commentId" in job.data && !job.id?.endsWith("_pub")) {
      owned.add(job.data.commentId);
    }
  }
  const marked = await prisma.dmLog.findMany({
    where: {
      status: "PENDING",
      errorMessage: { startsWith: SCHEDULED_RETRY_MARK },
      // A row is marked just before its job is added.
      updatedAt: { lt: new Date(Date.now() - 5 * 60_000) },
      createdAt: { gt: new Date(Date.now() - MAX_AGE_MS) },
    },
    select: { id: true, commentId: true },
  });
  const orphans = marked.filter((row) => !owned.has(row.commentId)).map((row) => row.id);
  if (orphans.length > 0) {
    await prisma.dmLog.updateMany({ where: { id: { in: orphans } }, data: { errorMessage: null } });
  }
  return orphans.length;
}

/** The worker's automatic re-send of everything that can still be delivered. */
export async function resendMissedComments(): Promise<number> {
  const workspaces = await prisma.workspace.findMany({
    where: { instagramAccounts: { some: {} } },
    select: { id: true },
  });
  let count = 0;
  for (const { id } of workspaces) {
    count += await requeueExpiredTokenComments(id);
    count += await requeueUnconfirmedDms(id);
  }
  count += await clearOrphanedRetryMarks();
  return count;
}
