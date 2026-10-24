import { prisma } from "@/lib/db/client";
import { storeContactProfile } from "@/lib/contacts/contacts";
import { createInstagramContext, type InstagramContext } from "@/lib/instagram/context";
import { getUserProfile } from "@/lib/instagram/read-analytics";

// A follower count this fresh is not looked up again.
const PROFILE_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Best-effort: read the person's display name, follower count and follow
 * status once they tap a campaign button (Instagram answers only inside an
 * open conversation), unless a lookup ran in the last 7 days. Never throws.
 */
export async function refreshContactProfile(
  context: InstagramContext,
  instagramAccountId: string,
  igsid: string
): Promise<"updated" | "fresh" | "missing" | "unavailable"> {
  try {
    const contact = await prisma.contact.findFirst({
      where: { instagramAccountId, igsid },
      select: { id: true, username: true, profileCheckedAt: true, followerCount: true },
    });
    if (!contact) return "missing";
    if (
      contact.followerCount != null &&
      contact.profileCheckedAt &&
      Date.now() - contact.profileCheckedAt.getTime() < PROFILE_FRESH_MS
    ) {
      return "fresh";
    }
    const profile = await getUserProfile({ context, igsid });
    if (!profile) return "unavailable";
    await storeContactProfile(contact, profile);
    return "updated";
  } catch (error) {
    console.log(
      "[Contacts] Profile lookup failed:",
      error instanceof Error ? error.message : error
    );
    return "unavailable";
  }
}

/**
 * Fill in follower counts for contacts that interacted recently and have
 * none yet. One batch per call so a request stays short; returns how many
 * are left.
 */
export async function backfillContactProfiles({
  workspaceId,
  accountId,
  sinceDays,
  batch,
}: {
  workspaceId: string;
  accountId: string;
  sinceDays: number;
  batch: number;
}) {
  const account = await prisma.instagramAccount.findFirst({
    where: { id: accountId, workspaceId },
  });
  if (!account) return null;
  const context = await createInstagramContext(account, `profile-backfill:${account.id}`);
  const where = {
    instagramAccountId: account.id,
    followerCount: null,
    profileCheckedAt: null,
    lastInteractionAt: { gte: new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000) },
  };
  const contacts = await prisma.contact.findMany({
    where,
    select: { igsid: true },
    orderBy: { lastInteractionAt: "desc" },
    take: batch,
  });

  const counts = { updated: 0, fresh: 0, missing: 0, unavailable: 0 };
  for (let i = 0; i < contacts.length; i += 5) {
    const results = await Promise.all(
      contacts.slice(i, i + 5).map((c) => refreshContactProfile(context, account.id, c.igsid))
    );
    for (const result of results) counts[result]++;
  }
  // Instagram could not answer for some (no open conversation): mark them
  // checked so the next batch moves on instead of asking again.
  if (counts.unavailable) {
    await prisma.contact.updateMany({
      where: { ...where, igsid: { in: contacts.map((c) => c.igsid) } },
      data: { profileCheckedAt: new Date() },
    });
  }
  const remaining = await prisma.contact.count({ where });
  return { checked: contacts.length, ...counts, remaining };
}
