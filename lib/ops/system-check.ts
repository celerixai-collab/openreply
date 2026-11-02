import { prisma } from "@/lib/db/client";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import { getWorkerHealth } from "@/lib/ops/worker-health";

export type SystemIssue = {
  id: string;
  title: string;
  detail: string;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TOKEN_WARNING_MS = 7 * DAY_MS;
const DM_FAILURE_THRESHOLD = 10;
const WEBHOOK_FAILURE_THRESHOLD = 5;
const QUEUE_BACKLOG_THRESHOLD = 500;
// The same problem is mailed again twice a day for as long as it lasts.
const REPEAT_ALERT_SECONDS = 12 * 60 * 60;
const REPLIED_NO_DM_AFTER_MS = 2 * HOUR_MS;
const CRON_LATE_AFTER_MS = 26 * HOUR_MS;
export const CRON_LAST_RUN_KEY = "ops:cron-last-run";
export const ALERT_FAILING_KEY = "ops:alert-failing";

/** Everything that can stop campaigns for one workspace, as of now. */
export async function checkWorkspace(workspaceId: string): Promise<SystemIssue[]> {
  const issues: SystemIssue[] = [];
  const now = Date.now();
  const hourAgo = new Date(now - HOUR_MS);
  const redis = getRedisConnection();

  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId, provider: "META" },
    select: { id: true, instagramId: true, username: true, tokenExpiresAt: true, webhookSubscribed: true },
  });
  for (const account of accounts) {
    const expiresAt = account.tokenExpiresAt?.getTime();
    if (expiresAt !== undefined && expiresAt < now) {
      issues.push({
        id: `token-expired:${account.id}`,
        title: `@${account.username} 的 Instagram token 已過期`,
        detail: "私訊和公開回覆都發不出去。到 Settings 按 Connect using your own Meta app 重新授權，不要按 Disconnect。",
      });
    } else if (expiresAt !== undefined && expiresAt < now + TOKEN_WARNING_MS) {
      issues.push({
        id: `token-expiring:${account.id}`,
        title: `@${account.username} 的 Instagram token 快過期，自動更新沒有成功`,
        detail: `到期時間：${new Date(expiresAt).toISOString().slice(0, 10)}。到 Settings 按 Connect using your own Meta app 重新授權，不要按 Disconnect。`,
      });
    }
    if (await redis.get(`token-invalid:${account.instagramId}`)) {
      issues.push({
        id: `token-rejected:${account.id}`,
        title: `Instagram 拒絕了 @${account.username} 的 token`,
        detail: "發送已自動暫停，沒有人會被算成失敗。可能改過密碼或移除過授權。到 Settings 按 Connect using your own Meta app 重新授權，連好後會自動接著發。",
      });
    }
    if (await redis.get(`cooldown:dm:${account.instagramId}`)) {
      issues.push({
        id: `throttled:${account.id}`,
        title: `Instagram 正在限制 @${account.username} 的發送速度`,
        detail: "私訊已自動暫停一段時間再重試。如果常收到這封，代表速度太快，要調低 DM_PACE_PER_MINUTE。",
      });
    }
    if (!account.webhookSubscribed) {
      issues.push({
        id: `webhook-off:${account.id}`,
        title: `@${account.username} 的 Webhook 沒有訂閱`,
        detail: "新留言可能收不到。到 Settings 重新按 Connect using your own Meta app。",
      });
    }
  }

  // Renewal starts at 30 days left and retries every 6 hours, so under 28 days
  // means it has kept failing; one stray failure, or one from before a reconnect, is not.
  const renewalDue = accounts.some(
    (a) => a.tokenExpiresAt && a.tokenExpiresAt.getTime() < now + 28 * DAY_MS
  );
  const refreshFailure = renewalDue && await prisma.operationalEvent.findFirst({
    where: {
      workspaceId,
      source: "TOKEN_REFRESH",
      level: "ERROR",
      createdAt: { gt: new Date(now - DAY_MS) },
    },
    orderBy: { createdAt: "desc" },
    select: { message: true },
  });
  if (refreshFailure) {
    issues.push({
      id: "token-refresh-failed",
      title: "Instagram token 自動更新失敗",
      detail: refreshFailure.message.slice(0, 300),
    });
  }

  const [failed, sent, webhookFailures] = await Promise.all([
    prisma.dmLog.count({ where: { workspaceId, status: "FAILED", updatedAt: { gt: hourAgo } } }),
    prisma.dmLog.count({ where: { workspaceId, status: "SENT", updatedAt: { gt: hourAgo } } }),
    prisma.webhookEvent.count({ where: { workspaceId, status: "FAILED", createdAt: { gt: hourAgo } } }),
  ]);
  if (failed >= DM_FAILURE_THRESHOLD && failed > sent) {
    const latest = await prisma.dmLog.findFirst({
      where: { workspaceId, status: "FAILED", updatedAt: { gt: hourAgo } },
      orderBy: { updatedAt: "desc" },
      select: { errorMessage: true },
    });
    issues.push({
      id: "dm-failures",
      title: `過去 1 小時有 ${failed} 則私訊失敗，只成功 ${sent} 則`,
      detail: `最新的錯誤：${(latest?.errorMessage ?? "沒有錯誤內容").slice(0, 300)}`,
    });
  }
  if (webhookFailures >= WEBHOOK_FAILURE_THRESHOLD) {
    issues.push({
      id: "webhook-failures",
      title: `過去 1 小時有 ${webhookFailures} 個 Webhook 事件處理失敗`,
      detail: "到 Diagnostics 頁面查看錯誤內容。",
    });
  }

  // A public reply says the DM is on its way, so one that never follows is the
  // failure people see first. Refusals nothing can fix are left out.
  const repliedNoDm = await prisma.dmLog.count({
    where: {
      workspaceId,
      status: { in: ["PENDING", "FAILED"] },
      publicReplySentAt: { lt: new Date(now - REPLIED_NO_DM_AFTER_MS), gt: new Date(now - 7 * DAY_MS) },
      NOT: [
        { errorMessage: { contains: "cannot be found" } },
        { errorMessage: { contains: "outside of allowed window" } },
      ],
    },
  });
  if (repliedNoDm > 0) {
    issues.push({
      id: "replied-no-dm",
      title: `有 ${repliedNoDm} 則留言已回覆超過 2 小時，Auto DM 還沒送到`,
      detail: "系統會自動補發一次；這封代表還有沒送到的，到 DM Logs 查看。",
    });
  }

  return issues;
}

/** Problems of the whole system. The worker cannot report its own death, so the web app checks that. */
export async function checkSystem({ includeWorker }: { includeWorker: boolean }): Promise<SystemIssue[]> {
  const issues: SystemIssue[] = [];
  const counts = await getDMQueue().getJobCounts("waiting");
  if ((counts.waiting ?? 0) > QUEUE_BACKLOG_THRESHOLD) {
    issues.push({
      id: "queue-backlog",
      title: `發送佇列塞了 ${counts.waiting} 個工作`,
      detail: "私訊可能會延遲。到 Diagnostics 頁面查看。",
    });
  }
  const cronLastRun = await getRedisConnection().get(CRON_LAST_RUN_KEY);
  if (cronLastRun && Date.now() - Number(cronLastRun) > CRON_LATE_AFTER_MS) {
    issues.push({
      id: "cron-late",
      title: "Vercel 的每日排程超過一天沒有執行",
      detail: "Token 更新還有 Railway 在做，但每月計數重置和其他排程會停。到 Vercel 的 Cron Jobs 頁面查看。",
    });
  }
  if (includeWorker && !(await getWorkerHealth()).healthy) {
    issues.push({
      id: "worker-down",
      title: "背景程式（Railway worker）沒有回應",
      detail: "留言不會被處理。到 Railway 查看 openreply 服務的狀態。",
    });
  }
  return issues;
}

/**
 * Run every check and hand new problems to `deliver`. A problem is marked as
 * mailed only after delivery works, so a failed mail is tried again next run.
 */
export async function runSystemCheck({
  includeWorker,
  deliver,
}: {
  includeWorker: boolean;
  deliver: (workspaceId: string, issues: SystemIssue[]) => Promise<void>;
}): Promise<number> {
  const workspaces = await prisma.workspace.findMany({
    where: { instagramAccounts: { some: {} } },
    select: { id: true },
  });
  const systemIssues = await checkSystem({ includeWorker });
  const redis = getRedisConnection();
  let alerted = 0;

  for (const { id: workspaceId } of workspaces) {
    const issues = [...systemIssues, ...(await checkWorkspace(workspaceId))];
    const fresh: SystemIssue[] = [];
    for (const issue of issues) {
      if (!(await redis.get(`alerts:sent:${workspaceId}:${issue.id}`))) fresh.push(issue);
    }
    if (fresh.length === 0) continue;
    await deliver(workspaceId, fresh);
    for (const issue of fresh) {
      await redis.set(`alerts:sent:${workspaceId}:${issue.id}`, "1", "EX", REPEAT_ALERT_SECONDS);
    }
    alerted += fresh.length;
  }
  return alerted;
}
