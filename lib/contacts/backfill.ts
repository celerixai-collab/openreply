import { prisma } from "@/lib/db/client";

/**
 * Turn every commenter in DmLog into a Contact. Contacts were only recorded
 * from 2026-10-09, when the Contacts page shipped; everyone a campaign
 * replied to before that exists only as DM log rows. Idempotent: existing
 * contacts are left as they are (skipDuplicates), so it is safe to rerun.
 */
export async function backfillContactsFromDmLogs(workspaceId?: string) {
  const logs = await prisma.dmLog.findMany({
    where: workspaceId ? { workspaceId } : undefined,
    select: {
      workspaceId: true,
      instagramAccountId: true,
      commenterId: true,
      commenterName: true,
      commentText: true,
      matchedKeyword: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  // One entry per person per account: the earliest and the latest comment.
  const people = new Map<
    string,
    { first: (typeof logs)[number]; last: (typeof logs)[number] }
  >();
  for (const log of logs) {
    const key = `${log.instagramAccountId}:${log.commenterId}`;
    const seen = people.get(key);
    if (seen) seen.last = log;
    else people.set(key, { first: log, last: log });
  }

  const rows = [...people.values()].map(({ first, last }) => ({
    workspaceId: first.workspaceId,
    instagramAccountId: first.instagramAccountId,
    igsid: first.commenterId,
    username: last.commenterName || first.commenterName || null,
    lastTriggerType: "comment",
    lastTriggerText: last.commentText,
    lastTriggerKeyword: last.matchedKeyword,
    lastTriggerAt: last.createdAt,
    firstSeenAt: first.createdAt,
    lastInteractionAt: last.createdAt,
  }));

  let created = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const result = await prisma.contact.createMany({
      data: rows.slice(i, i + 500),
      skipDuplicates: true,
    });
    created += result.count;
  }
  return { logs: logs.length, people: rows.length, created };
}
