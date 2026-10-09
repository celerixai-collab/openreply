import { prisma } from "@/lib/db/client";
import { getMetaGraphApiVersion } from "@/lib/env";
import { createInstagramContext } from "@/lib/instagram/context";
import {
  getAllUserMedia,
  RateLimitError,
  type InstagramComment,
} from "@/lib/meta/client";

function instagramGraphBase() {
  return `https://graph.instagram.com/${getMetaGraphApiVersion()}`;
}

/** Where an import stopped: which account, which post, which comment page. */
export type ImportCursor = {
  accountId: string;
  mediaIndex: number;
  after: string | null;
};

export type ImportResult = {
  cursor: ImportCursor | null;
  scannedComments: number;
  created: number;
  account: string | null;
  mediaDone: number;
  mediaTotal: number;
  rateLimited: boolean;
  skippedAccounts: string[];
};

type Commenter = {
  id: string;
  username?: string;
  text: string;
  at: string;
  mediaId: string;
};

async function commentPage(
  accessToken: string,
  mediaId: string,
  after: string | null,
): Promise<{ data: InstagramComment[]; after: string | null }> {
  const url = new URL(`${instagramGraphBase()}/${mediaId}/comments`);
  url.searchParams.set(
    "fields",
    "id,text,timestamp,from,replies{id,text,timestamp,from}",
  );
  url.searchParams.set("limit", "50");
  if (after) url.searchParams.set("after", after);
  url.searchParams.set("access_token", accessToken);
  const response = await fetch(url.toString());
  const body = await response.json();
  if (!response.ok) {
    const code = body?.error?.code;
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    if (
      code === 4 ||
      code === 17 ||
      code === 32 ||
      code === 613 ||
      response.status === 429
    )
      throw new RateLimitError(message, body?.error?.fbtrace_id);
    throw new Error(message);
  }
  return {
    data: body.data ?? [],
    after: body.paging?.next ? (body.paging?.cursors?.after ?? null) : null,
  };
}

/**
 * Add every person who commented (or replied in a thread) on the account's
 * posts as a Contact. Works in slices so one request stays inside the
 * serverless time limit: call again with the returned cursor until it is null.
 * Existing contacts are never overwritten (createMany skipDuplicates).
 */
export async function importCommenters(
  workspaceId: string,
  cursor: ImportCursor | null,
  budgetMs = 40_000,
): Promise<ImportResult> {
  const started = Date.now();
  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId },
    orderBy: { connectedAt: "asc" },
    select: {
      id: true,
      username: true,
      instagramId: true,
      provider: true,
      workspaceId: true,
      zernioAccountId: true,
      accessToken: true,
    },
  });
  const skippedAccounts = accounts
    .filter((a) => a.provider !== "META")
    .map((a) => a.username);
  const metaAccounts = accounts.filter((a) => a.provider === "META");

  let accountIndex = cursor
    ? metaAccounts.findIndex((a) => a.id === cursor.accountId)
    : 0;
  if (accountIndex < 0) accountIndex = 0;
  let mediaIndex = cursor?.mediaIndex ?? 0;
  let after = cursor?.after ?? null;
  let scannedComments = 0;
  let created = 0;
  let mediaTotal = 0;

  const save = async (
    people: Map<string, Commenter>,
    account: (typeof metaAccounts)[number],
  ) => {
    if (!people.size) return;
    const result = await prisma.contact.createMany({
      data: [...people.values()].map((p) => ({
        workspaceId,
        instagramAccountId: account.id,
        igsid: p.id,
        username: p.username ?? null,
        lastTriggerType: "comment",
        lastTriggerText: p.text,
        lastTriggerMediaId: p.mediaId,
        lastTriggerAt: new Date(p.at),
        firstSeenAt: new Date(p.at),
        lastInteractionAt: new Date(p.at),
      })),
      skipDuplicates: true,
    });
    created += result.count;
    people.clear();
  };

  for (; accountIndex < metaAccounts.length; accountIndex++) {
    const account = metaAccounts[accountIndex];
    const context = await createInstagramContext(account);
    if (context.provider !== "META") continue;
    const media = await getAllUserMedia(context.accessToken, 2000);
    mediaTotal = media.length;
    const people = new Map<string, Commenter>();
    const note = (
      c: {
        from?: { id: string; username?: string };
        text?: string;
        timestamp?: string;
      },
      mediaId: string,
    ) => {
      if (
        !c.from?.id ||
        c.from.id === account.instagramId ||
        c.from.username === account.username
      )
        return;
      const at = c.timestamp ?? new Date().toISOString();
      const seen = people.get(c.from.id);
      if (!seen || at > seen.at)
        people.set(c.from.id, {
          id: c.from.id,
          username: c.from.username,
          text: c.text ?? "",
          at,
          mediaId,
        });
    };

    for (; mediaIndex < media.length; mediaIndex++) {
      const mediaId = media[mediaIndex].id;
      do {
        if (Date.now() - started > budgetMs) {
          await save(people, account);
          return {
            cursor: { accountId: account.id, mediaIndex, after },
            scannedComments,
            created,
            account: account.username,
            mediaDone: mediaIndex,
            mediaTotal,
            rateLimited: false,
            skippedAccounts,
          };
        }
        let page;
        try {
          page = await commentPage(context.accessToken, mediaId, after);
        } catch (error) {
          await save(people, account);
          if (error instanceof RateLimitError)
            return {
              cursor: { accountId: account.id, mediaIndex, after },
              scannedComments,
              created,
              account: account.username,
              mediaDone: mediaIndex,
              mediaTotal,
              rateLimited: true,
              skippedAccounts,
            };
          throw error;
        }
        for (const comment of page.data) {
          scannedComments++;
          note(comment, mediaId);
          for (const reply of (comment.replies?.data ??
            []) as InstagramComment[]) {
            scannedComments++;
            note(reply, mediaId);
          }
        }
        after = page.after;
        if (people.size >= 500) await save(people, account);
      } while (after);
    }
    await save(people, account);
    mediaIndex = 0;
    after = null;
  }

  return {
    cursor: null,
    scannedComments,
    created,
    account: null,
    mediaDone: mediaTotal,
    mediaTotal,
    rateLimited: false,
    skippedAccounts,
  };
}
