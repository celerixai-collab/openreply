import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { refreshExpiringTokens } from "@/lib/instagram/token-refresh";
import { alertSubject, emailWorkspaceOwner } from "@/lib/ops/alert-email";
import { CRON_LAST_RUN_KEY, runSystemCheck } from "@/lib/ops/system-check";
import { getRedisConnection } from "@/lib/queue/client";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  await getRedisConnection().set(CRON_LAST_RUN_KEY, String(Date.now()));

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const usageReset = await prisma.workspace.updateMany({
    where: { usagePeriodStart: { lt: monthStart } },
    data: {
      usagePeriodStart: monthStart,
      dmsSentThisPeriod: 0,
    },
  });

  const results = await refreshExpiringTokens();

  // The worker runs these checks every 10 minutes but cannot report itself
  // being down, so this one also looks at the worker.
  const alerted = await runSystemCheck({
    includeWorker: true,
    deliver: (workspaceId, issues) =>
      emailWorkspaceOwner(workspaceId, alertSubject(issues), issues),
  }).catch((error) => {
    console.error("[System check] Failed:", error);
    return 0;
  });

  return NextResponse.json({
    success: true,
    data: {
      totalProcessed: results.length,
      workspacesReset: usageReset.count,
      alerted,
      results,
    },
  });
}
