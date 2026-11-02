import { prisma } from "@/lib/db/client";

export const MAX_COMMENT_SEND_ATTEMPTS = 3;

// Marks a DmLog whose comment already has a delayed job queued (paced,
// throttled, over the hourly cap), so the reconciler does not queue another.
export const SCHEDULED_RETRY_MARK = "Retry scheduled:";

// Prefixes a public-reply error that will never succeed (the comment was
// deleted, the person is gone), so neither the worker nor the reconciler
// tries that reply again.
export const PUBLIC_REPLY_GAVE_UP_MARK = "Gave up:";

export function publicReplyGaveUp(publicReplyError: string | null | undefined): boolean {
  return Boolean(publicReplyError?.startsWith(PUBLIC_REPLY_GAVE_UP_MARK));
}

// A durable, atomic claim precedes the external side effect. If the process
// crashes or the final log write fails, an uncertain send must not be repeated.
export async function claimCommentDelivery(
  automationId: string,
  commentId: string,
  leg: "dm" | "public",
): Promise<boolean> {
  const result = await prisma.dmLog.updateMany({
    where: {
      automationId,
      commentId,
      ...(leg === "dm"
        ? {
            status: { not: "SENT" as const },
            dmDeliveryUnconfirmed: false,
            attempts: { lt: MAX_COMMENT_SEND_ATTEMPTS },
          }
        : { publicReplySentAt: null, publicReplyDeliveryUnconfirmed: false }),
    },
    data:
      leg === "dm"
        ? {
            dmDeliveryUnconfirmed: true,
            attempts: { increment: 1 },
            status: "PENDING",
            errorMessage: null,
          }
        : { publicReplyDeliveryUnconfirmed: true },
  });
  return result.count === 1;
}
