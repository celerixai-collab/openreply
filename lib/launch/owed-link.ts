import { prisma } from "@/lib/db/client";
import {
  createInstagramContext,
  hasInstagramCredentials,
} from "@/lib/instagram/context";
import {
  sendDirectMessageWithLinkButton,
  sendPrivateReplyWithLinkButton,
} from "@/lib/instagram/send-messages";
import { isConfirmedSendRejection } from "@/lib/instagram/delivery-errors";
import { getRedisConnection } from "@/lib/queue/client";
import { CAMPAIGN_NAME, SENT_KEY } from "@/lib/launch/launch-drip";

/**
 * The launch link owed to every A–F commenter who has not got it yet.
 * Instagram only lets us message someone who has just interacted, so the
 * link waits for their next interaction anywhere on the account (a comment
 * on any post, a DM, a story reply) and goes out then, once per person.
 */
export const OWED_KEY = "launch-blast:owed";
// Test accounts that are treated as owed even if they never commented on A–F.
export const OWED_TEST_KEY = "launch-blast:owed:test";

type OwedSettings = {
  enabled: boolean;
  text: string;
  buttonTitle: string;
  url: string;
  launchAt?: Date;
};

export async function getOwedSettings(): Promise<OwedSettings> {
  const raw = await getRedisConnection().hgetall(OWED_KEY);
  return {
    enabled: raw.enabled === "1",
    text: raw.text ?? "",
    buttonTitle: raw.buttonTitle ?? "",
    url: raw.url ?? "",
    launchAt: raw.launchAt ? new Date(raw.launchAt) : undefined,
  };
}

export async function setOwedSettings(settings: {
  enabled: boolean;
  text: string;
  buttonTitle: string;
  url: string;
  launchAt: Date;
}): Promise<void> {
  await getRedisConnection().hset(OWED_KEY, {
    enabled: settings.enabled ? "1" : "0",
    text: settings.text,
    buttonTitle: settings.buttonTitle,
    url: settings.url,
    launchAt: settings.launchAt.toISOString(),
  });
}

/** Whether this person commented on an A–F campaign and has no link yet. */
export async function isOwedLaunchLink(
  instagramAccountDbId: string,
  userId: string,
  launchAt?: Date,
): Promise<boolean> {
  if (await getRedisConnection().sismember(SENT_KEY, userId)) return false;
  const logs = await prisma.dmLog.findMany({
    where: { instagramAccountId: instagramAccountDbId, commenterId: userId },
    select: { status: true, dmSentAt: true, automation: { select: { name: true } } },
  });
  const launchLogs = logs.filter((l) => CAMPAIGN_NAME.test(l.automation.name));
  if (launchLogs.length === 0) return false;
  return !launchLogs.some(
    (l) => l.status === "SENT" && launchAt && l.dmSentAt && l.dmSentAt >= launchAt,
  );
}

/**
 * Send the owed link if this person is owed one. A comment gets a private
 * reply on that comment; a DM or story reply gets a plain DM. Never throws:
 * it rides along with other work and must not fail it.
 */
export async function deliverOwedLaunchLink({
  instagramAccountId,
  userId,
  commentId,
}: {
  instagramAccountId: string;
  userId: string;
  commentId?: string;
}): Promise<void> {
  try {
    const settings = await getOwedSettings();
    if (!settings.enabled || !settings.text || !settings.url) return;

    const account = await prisma.instagramAccount.findFirst({
      where: { instagramId: instagramAccountId },
    });
    if (!account || !hasInstagramCredentials(account) || userId === account.instagramId) return;
    const redis = getRedisConnection();
    const isTest = (await redis.sismember(OWED_TEST_KEY, userId)) === 1;
    if (!isTest && !(await isOwedLaunchLink(account.id, userId, settings.launchAt))) return;

    // Claim first, so two events at once cannot both send.
    if ((await redis.sadd(SENT_KEY, userId)) !== 1) return;

    const buttons = [{ title: settings.buttonTitle || "購買教學", url: settings.url }];
    try {
      const context = await createInstagramContext(account, `launch-owed:${commentId ?? userId}`);
      if (commentId) {
        await sendPrivateReplyWithLinkButton({
          context,
          instagramAccountId: account.instagramId,
          commentId,
          text: settings.text,
          buttons,
        });
      } else {
        await sendDirectMessageWithLinkButton({
          context,
          instagramAccountId: account.instagramId,
          userId,
          text: settings.text,
          buttons,
        });
      }
      console.log(`[Launch owed] Sent the launch link to ${userId} via ${commentId ? "comment" : "DM"}`);
    } catch (error) {
      // A refusal means nothing went out, so the person stays owed for next time.
      if (isConfirmedSendRejection(error)) await redis.srem(SENT_KEY, userId);
      console.error(
        `[Launch owed] Could not send the launch link to ${userId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  } catch (error) {
    console.error(
      "[Launch owed] Check failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}
