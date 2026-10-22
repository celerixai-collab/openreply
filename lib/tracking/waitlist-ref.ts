import { prisma } from "@/lib/db/client";
import { hashRecipientId } from "@/lib/tracking/server";

/**
 * Leo's early-bird waitlist: links to these hosts carry who tapped them, so
 * the sign-up form can show and store the person's Instagram username.
 * Links to any other host are redirected exactly as before.
 */
export const WAITLIST_ORIGINS = ["https://leo-waitlist.vercel.app"];

function isWaitlistUrl(url: string) {
  try {
    return WAITLIST_ORIGINS.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

/** Adds `or_s` (link slug) and `or_r` (recipient token) to a waitlist link. */
export function withWaitlistRef(
  destinationUrl: string,
  slug: string,
  recipientToken: string | null
) {
  if (!recipientToken || !isWaitlistUrl(destinationUrl)) return destinationUrl;
  const url = new URL(destinationUrl);
  url.searchParams.set("or_s", slug);
  url.searchParams.set("or_r", recipientToken);
  return url.toString();
}

export type WaitlistRef = { username: string; campaign: string };

/**
 * The username of the person a waitlist link was sent to, found among the
 * people its campaign sent a DM to. Null for other links or unknown tokens.
 */
export async function resolveWaitlistRef(
  slug: string,
  recipientToken: string
): Promise<WaitlistRef | null> {
  const link = await prisma.trackedLink.findUnique({
    where: { slug },
    select: {
      destinationUrl: true,
      automationId: true,
      automation: { select: { name: true, instagramAccountId: true } },
    },
  });
  if (!link || !isWaitlistUrl(link.destinationUrl)) return null;

  const logs = await prisma.dmLog.findMany({
    where: { automationId: link.automationId },
    select: { commenterId: true, commenterName: true },
    distinct: ["commenterId"],
  });
  const match = logs.find((log) => hashRecipientId(log.commenterId) === recipientToken);
  if (!match) return null;

  let username = match.commenterName?.trim() || null;
  if (!username) {
    const contact = await prisma.contact.findFirst({
      where: { instagramAccountId: link.automation.instagramAccountId, igsid: match.commenterId },
      select: { username: true },
    });
    username = contact?.username?.trim() || null;
  }
  if (!username) return null;
  return { username: username.replace(/^@/, ""), campaign: link.automation.name };
}
