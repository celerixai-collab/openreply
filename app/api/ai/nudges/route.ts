import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { accountAccess, accessError } from "@/lib/ai/route-access";
import { firstIssue } from "@/lib/ai/brain";
import { getNudgeSettings, NUDGE_LIMITS, nudgeDelays, setNudgeSettings } from "@/lib/ai/nudges";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z
  .object({
    accountId: z.string(),
    enabled: z.boolean(),
    intervalHours: z.number().min(NUDGE_LIMITS.minHours).max(NUDGE_LIMITS.maxHours),
    messages: z
      .array(z.string().trim().min(1).max(NUDGE_LIMITS.messageLength))
      .max(NUDGE_LIMITS.messages),
  })
  .strict();

function describe(settings: Awaited<ReturnType<typeof getNudgeSettings>>) {
  // Which messages fit inside the 24-hour window, in hours after their last message.
  const schedule = nudgeDelays(settings.intervalHours, settings.messages.length).map((ms) => ms / 3_600_000);
  return { ...settings, scheduleHours: schedule };
}

/** The account's nudge settings. */
export async function GET(request: NextRequest) {
  const access = await accountAccess(request.nextUrl.searchParams.get("accountId"), { manage: true });
  if (!access.ok) return access.response;
  return NextResponse.json({ success: true, data: describe(await getNudgeSettings(access.account.id)) });
}

/** Replace the account's nudge settings. */
export async function PUT(request: NextRequest) {
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return accessError(400, firstIssue(body.error)).response;
  const access = await accountAccess(body.data.accountId, { manage: true });
  if (!access.ok) return access.response;
  const { enabled, intervalHours, messages } = body.data;
  await setNudgeSettings(access.account.id, { enabled, intervalHours, messages });
  return NextResponse.json({ success: true, data: describe(await getNudgeSettings(access.account.id)) });
}
