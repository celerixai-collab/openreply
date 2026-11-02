import { createDMWorker } from "@/lib/queue/dm-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import { attachPendingNextReels } from "@/lib/automation/attach-next-reel";
import { createAiWorker } from "@/lib/ai/worker";
import { isAiConfigured } from "@/lib/ai/client";
import { expireStaleAiDrafts } from "@/lib/ai/drafts";
import { refreshExpiringTokens } from "@/lib/instagram/token-refresh";
import { ALERT_FAILING_KEY, runSystemCheck, type SystemIssue } from "@/lib/ops/system-check";
import { snapshotAllFollowers } from "@/lib/reports/follower-history";
import { getRedisConnection } from "@/lib/queue/client";
import { alertAuthToken } from "@/lib/ops/alert-email";
import { takeApiUsageReport } from "@/lib/meta/api-usage";
import { getBaseUrl } from "@/lib/env";
import { runLaunchDripTick } from "@/lib/launch/launch-drip";
import {
  markRefusedRepeatsDelivered,
  removeDuplicateDelayedComments,
  respaceWaitingComments,
  requeuePersonDedupSkips,
  resendMissedComments,
  requeueThrottledComments,
  requeueThrottledEverywhere,
  retestNotFoundOnce,
} from "@/lib/queue/requeue-throttled";
import os from "node:os";

const worker = createDMWorker();
// AI DM assistant (draft mode). Its jobs are only queued for accounts that
// turned the assistant on, and only while ANTHROPIC_API_KEY is set here.
const aiWorker = createAiWorker();
const startedAt = new Date().toISOString();
const HEARTBEAT_INTERVAL_MS = 30_000;
// Polling safety net for comments that webhooks miss. Runs in the worker because
// it must fire every few minutes and Vercel's free crons only run once a day.
const POLL_INTERVAL_MS = Number(
  process.env.COMMENT_POLL_INTERVAL_MS ?? 5 * 60_000
);

console.log("[DM Worker] Started");

void requeueThrottledEverywhere().catch((error) =>
  console.error(
    "[DM Worker] Re-queueing throttled comments failed:",
    error instanceof Error ? error.message : error
  )
);
void retestNotFoundOnce().catch((error) =>
  console.error(
    "[DM Worker] Retesting refused comments failed:",
    error instanceof Error ? error.message : error
  )
);
void markRefusedRepeatsDelivered().catch((error) =>
  console.error(
    "[DM Worker] Marking refused repeats failed:",
    error instanceof Error ? error.message : error
  )
);
void requeuePersonDedupSkips().catch((error) =>
  console.error(
    "[DM Worker] Re-queueing repeat comments failed:",
    error instanceof Error ? error.message : error
  )
);
void removeDuplicateDelayedComments().then(respaceWaitingComments).catch((error) =>
  console.error(
    "[DM Worker] Tidying the waiting jobs failed:",
    error instanceof Error ? error.message : error
  )
);
void requeueThrottledComments().catch((error) =>
  console.error(
    "[DM Worker] Re-queueing throttled comments failed:",
    error instanceof Error ? error.message : error
  )
);

async function heartbeat() {
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
      aiConfigured: isAiConfigured(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function poll() {
  try {
    const attached = await attachPendingNextReels();
    if (attached.bound > 0 || attached.failedAccounts > 0) {
      console.log("[DM Worker] Next-reel attachment:", attached);
    }
    await reconcileComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Comment reconciliation failed:", message);
  }
  try {
    // AI drafts past Instagram's 24-hour window can no longer be sent.
    await expireStaleAiDrafts();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Expiring AI drafts failed:", message);
  }
}

// Kick off one sweep shortly after boot, then on a fixed interval.
setTimeout(() => void poll(), 10_000);
const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

// The launch announcement's public replies, one a minute while it is switched on.
const launchDripTimer = setInterval(() => {
  runLaunchDripTick().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Launch drip failed:", message);
  });
}, 60_000);

// Daily work belongs here, not in a Vercel cron. Vercel's cron calls reached the
// routes without the secret and were refused every day until 2026-11-02, with
// nobody told, which is how the Instagram token ran out.
const TOKEN_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
async function refreshTokens() {
  try {
    const results = await refreshExpiringTokens();
    for (const result of results) {
      if (result.status === "refreshed") {
        console.log(`[DM Worker] Refreshed the Instagram token of @${result.username}`);
      } else {
        console.error(`[DM Worker] Could not refresh the Instagram token of @${result.username}: ${result.error}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Token refresh failed:", message);
  }
}
async function snapshotFollowers() {
  try {
    const { recorded, failures } = await snapshotAllFollowers();
    console.log(`[DM Worker] Follower snapshot: ${recorded} recorded, ${failures.length} failed`);
  } catch (error) {
    console.error("[DM Worker] Follower snapshot failed:", error instanceof Error ? error.message : error);
  }
}
setTimeout(() => {
  void refreshTokens();
  void snapshotFollowers();
}, 30_000);
const tokenRefreshTimer = setInterval(() => {
  void refreshTokens();
  void snapshotFollowers();
}, TOKEN_REFRESH_INTERVAL_MS);

// Mail the owner when a check finds a problem. The mail key lives on the web
// app, so the worker asks it to send.
const SYSTEM_CHECK_INTERVAL_MS = 10 * 60_000;
async function postAlert(body: { ping: true } | { workspaceId: string; issues: SystemIssue[] }) {
  const response = await fetch(`${getBaseUrl()}/api/ops/alert`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${alertAuthToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Alert endpoint answered ${response.status}`);
}
// The outside uptime check reads this, so a broken mail path is noticed too.
async function noteAlertFailing(failing: boolean): Promise<void> {
  const redis = getRedisConnection();
  await (failing ? redis.set(ALERT_FAILING_KEY, "1", "EX", 60 * 60) : redis.del(ALERT_FAILING_KEY)).catch(() => undefined);
}
async function systemCheck() {
  const apiUsage = takeApiUsageReport();
  if (apiUsage) console.log(`[API usage, last 10 min] ${apiUsage}`);
  try {
    const alerted = await runSystemCheck({
      includeWorker: false,
      deliver: (workspaceId, issues) => postAlert({ workspaceId, issues }),
    });
    if (alerted > 0) console.log(`[System check] Mailed ${alerted} problem(s) to the owner`);
    await noteAlertFailing(false);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[System check] Failed:", message);
    await noteAlertFailing(true);
  }
}
postAlert({ ping: true })
  .then(() => {
    console.log("[System check] Alert endpoint reachable");
    return noteAlertFailing(false);
  })
  .catch((error) => {
    console.error("[System check] Alert endpoint not reachable:", error instanceof Error ? error.message : error);
    return noteAlertFailing(true);
  });
async function resendMissed() {
  try {
    const count = await resendMissedComments();
    if (count > 0) console.log(`[DM Worker] Re-queued ${count} comments that were never delivered`);
  } catch (error) {
    console.error("[DM Worker] Re-sending missed comments failed:", error instanceof Error ? error.message : error);
  }
}
setTimeout(() => {
  void systemCheck();
  void resendMissed();
}, 60_000);
const systemCheckTimer = setInterval(() => {
  void systemCheck();
  void resendMissed();
}, SYSTEM_CHECK_INTERVAL_MS);

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  clearInterval(launchDripTimer);
  clearInterval(tokenRefreshTimer);
  clearInterval(systemCheckTimer);
  await Promise.all([worker.close(), aiWorker.close()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
