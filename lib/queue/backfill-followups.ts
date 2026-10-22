/**
 * One-time backfill, run by the worker at start-up: the early-bird campaigns
 * got their follow-up turned on at 2026-10-22 16:50 UTC. People who received
 * the link shortly before that get the follow-up too, if Instagram still
 * allows a message (24 hours from their tap). Each person once; the job id
 * is the same one a normal follow-up uses.
 */

import { prisma } from "@/lib/db/client";
import { claimOnce } from "@/lib/contacts/contacts";
import { FOLLOWUP_JOB_NAME, getDMQueue } from "@/lib/queue/client";

const RUN_ID = "followup-backfill-2026-10-22";
const ENABLED_AT = new Date("2026-10-22T16:50:00Z");
const CAMPAIGN_PREFIX = "剪輯室 早鳥等候";
// A little under Instagram's 24-hour window, leaving time for the spread.
const MAX_AGE_MS = 21 * 60 * 60 * 1000;
// Space the sends out instead of firing them all at once.
const SPACING_MS = 15_000;

export async function backfillFollowUps(now = new Date()): Promise<number> {
  if (!(await claimOnce(RUN_ID))) return 0;

  const automations = await prisma.automation.findMany({
    where: {
      name: { startsWith: CAMPAIGN_PREFIX },
      isActive: true,
      followUpEnabled: true,
    },
    select: {
      id: true,
      instagramAccountId: true,
      instagramAccount: { select: { instagramId: true } },
    },
  });
  if (automations.length === 0) return 0;

  const reveals = await prisma.dmLog.findMany({
    where: {
      automationId: { in: automations.map((a) => a.id) },
      commentId: { startsWith: "reveal:" },
      status: "SENT",
      dmSentAt: { gt: new Date(now.getTime() - MAX_AGE_MS), lt: ENABLED_AT },
    },
    select: { automationId: true, commenterId: true, commenterName: true },
    orderBy: { dmSentAt: "asc" },
  });

  const queue = getDMQueue();
  let queued = 0;
  for (const reveal of reveals) {
    const automation = automations.find((a) => a.id === reveal.automationId)!;
    await queue.add(
      FOLLOWUP_JOB_NAME,
      {
        instagramAccountId: automation.instagramAccount.instagramId,
        accountConnectionId: automation.instagramAccountId,
        userId: reveal.commenterId,
        automationId: automation.id,
        commenterName: reveal.commenterName,
      },
      {
        delay: queued * SPACING_MS,
        jobId: `followup_${automation.id}_${reveal.commenterId}`,
      }
    );
    queued++;
  }
  console.log(`[DM Worker] Backfilled ${queued} early-bird follow-ups`);
  return queued;
}
