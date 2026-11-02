import { prisma } from "@/lib/db/client";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import { getWorkerHealth } from "@/lib/ops/worker-health";
import { FIRST_RENEWAL_DAYS_LEFT, TOKEN_RENEWAL_PROVEN_KEY } from "@/lib/queue/token-pause";

export type SystemIssue = {
  id: string;
  title: string;
  detail: string;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TOKEN_WARNING_MS = 7 * DAY_MS;
const DM_FAILURE_MIN = 20;
const WEBHOOK_FAILURE_THRESHOLD = 5;
const QUEUE_RUNAWAY_THRESHOLD = 3000;
// The same problem is mailed again twice a day for as long as it lasts.
const REPEAT_ALERT_SECONDS = 12 * 60 * 60;
const COMMENT_STUCK_AFTER_MS = 3 * HOUR_MS;
const COMMENT_STUCK_MIN = 5;
// Each campaign is swept 12 times an hour; half of those failing is not a blip.
const SWEEP_FAILURES_PER_CAMPAIGN = 6;
const RECONNECT = "到 Settings 按 Connect using your own Meta app 重新授權，不要按 Disconnect，連好後會自動接著發。";
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
        detail: `要你動手：私訊和公開回覆都發不出去，留言會先排隊。${RECONNECT}`,
      });
    } else if (expiresAt !== undefined && expiresAt < now + TOKEN_WARNING_MS) {
      issues.push({
        id: `token-expiring:${account.id}`,
        title: `@${account.username} 的 Instagram token 快過期，自動更新沒有成功`,
        detail: `要你動手：到期時間 ${new Date(expiresAt).toISOString().slice(0, 10)}。${RECONNECT}`,
      });
    }
    if (await redis.get(`token-invalid:${account.instagramId}`)) {
      issues.push({
        id: `token-rejected:${account.id}`,
        title: `Instagram 拒絕了 @${account.username} 的 token`,
        detail: `要你動手：發送已自動暫停，沒有人會被算成失敗。可能改過密碼或移除過授權。${RECONNECT}`,
      });
    }
    if (!account.webhookSubscribed) {
      issues.push({
        id: `webhook-off:${account.id}`,
        title: `@${account.username} 的 Webhook 沒有訂閱`,
        detail: `要你動手：新留言要等定期掃描才收得到。${RECONNECT}`,
      });
    }
  }

  // Renewal starts at 30 days left and retries every 6 hours, so under 28 days
  // means it has kept failing; one stray failure, or one from before a reconnect,
  // is not. Until a renewal has ever worked, the first try already counts.
  const renewalProven = await redis.get(TOKEN_RENEWAL_PROVEN_KEY);
  const renewalDueWithin = (renewalProven ? 28 : FIRST_RENEWAL_DAYS_LEFT) * DAY_MS;
  const renewalDue = accounts.some(
    (a) => a.tokenExpiresAt && a.tokenExpiresAt.getTime() < now + renewalDueWithin
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
      detail: `交給 Claude：token 還有效，系統每 6 小時會再試。把這封貼給 Claude。錯誤：${refreshFailure.message.slice(0, 300)}`,
    });
  }

  const [failed, sent, webhookFailures, stuck, sweepFailures, activeCampaigns] = await Promise.all([
    // Refusals about one person or comment say nothing about the system.
    prisma.dmLog.count({
      where: {
        workspaceId,
        status: "FAILED",
        updatedAt: { gt: hourAgo },
        NOT: [
          { errorMessage: { contains: "cannot be found" } },
          { errorMessage: { contains: "outside of allowed window" } },
          { errorMessage: { contains: "invalid for a private reply" } },
        ],
      },
    }),
    prisma.dmLog.count({ where: { workspaceId, status: "SENT", updatedAt: { gt: hourAgo } } }),
    prisma.webhookEvent.count({ where: { workspaceId, status: "FAILED", createdAt: { gt: hourAgo } } }),
    // What people actually experience, whatever the cause, including causes
    // nobody has thought of yet.
    prisma.dmLog.count({
      where: {
        workspaceId,
        status: "PENDING",
        NOT: { commentId: { startsWith: "reveal:" } },
        createdAt: { lt: new Date(now - COMMENT_STUCK_AFTER_MS), gt: new Date(now - 7 * DAY_MS) },
      },
    }),
    prisma.operationalEvent.count({
      where: {
        workspaceId,
        source: "SYSTEM",
        level: "WARNING",
        message: { startsWith: "Comment sweep" },
        createdAt: { gt: hourAgo },
      },
    }),
    prisma.automation.count({ where: { workspaceId, isActive: true } }),
  ]);
  if (failed >= DM_FAILURE_MIN && failed * 4 >= sent) {
    const latest = await prisma.dmLog.findFirst({
      where: { workspaceId, status: "FAILED", updatedAt: { gt: hourAgo } },
      orderBy: { updatedAt: "desc" },
      select: { errorMessage: true },
    });
    issues.push({
      id: "dm-failures",
      title: `過去 1 小時有 ${failed} 則私訊失敗，成功 ${sent} 則`,
      detail: `交給 Claude：把這封貼給 Claude。最新的錯誤：${(latest?.errorMessage ?? "沒有錯誤內容").slice(0, 300)}`,
    });
  }
  if (webhookFailures >= WEBHOOK_FAILURE_THRESHOLD) {
    issues.push({
      id: "webhook-failures",
      title: `過去 1 小時有 ${webhookFailures} 個 Webhook 事件處理失敗`,
      detail: "交給 Claude：定期掃描會補上這些留言，把這封貼給 Claude 查原因。",
    });
  }
  if (stuck >= COMMENT_STUCK_MIN) {
    issues.push({
      id: "comments-stuck",
      title: `有 ${stuck} 則留言等超過 3 小時還沒收到 DM`,
      detail: "不用動手：系統會繼續依序補發，7 天內都補得到。如果明天還收到這封，把這封貼給 Claude。",
    });
  }
  if (activeCampaigns > 0 && sweepFailures >= activeCampaigns * SWEEP_FAILURES_PER_CAMPAIGN) {
    issues.push({
      id: "sweep-failures",
      title: "定期掃描留言一直失敗",
      detail: "交給 Claude：Webhook 漏掉的留言現在補不到，把這封貼給 Claude。",
    });
  }

  return issues;
}

/** Problems of the whole system. The worker cannot report its own death, so the web app checks that. */
export async function checkSystem({ includeWorker }: { includeWorker: boolean }): Promise<SystemIssue[]> {
  const issues: SystemIssue[] = [];
  const counts = await getDMQueue().getJobCounts("waiting", "delayed");
  const queued = (counts.waiting ?? 0) + (counts.delayed ?? 0);
  if (queued > QUEUE_RUNAWAY_THRESHOLD) {
    issues.push({
      id: "queue-backlog",
      title: `發送佇列有 ${queued} 個工作，數量不正常`,
      detail: "交給 Claude：私訊會延遲，把這封貼給 Claude。",
    });
  }
  if (includeWorker && !(await getWorkerHealth()).healthy) {
    issues.push({
      id: "worker-down",
      title: "背景程式（Railway worker）沒有回應",
      detail: "交給 Claude：留言會先排隊，恢復後自動補發。把這封貼給 Claude。",
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
