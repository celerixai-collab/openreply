import { NextRequest, NextResponse } from "next/server";
import { isCronRequest } from "@/lib/ops/cron-auth";
import { snapshotAllFollowers } from "@/lib/reports/follower-history";

/**
 * Records one follower total per connected account per day.
 *
 * Instagram retains only ~30 days of account insights, so this job is the only
 * source of longer-range follower history. Missing a run loses that day
 * permanently — there is no way to backfill beyond the insights window.
 */
export async function GET(request: NextRequest) {
  if (!isCronRequest(request)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  return NextResponse.json({ success: true, data: await snapshotAllFollowers() });
}
