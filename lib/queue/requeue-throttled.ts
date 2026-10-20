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
