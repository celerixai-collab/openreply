/**
 * Comment reconciliation (polling safety net).
 *
 * Instagram webhooks are best-effort and never fire for a large class of
 * comments (collapsed "load more" comments, non-follower / low-signal accounts,
 * anything Instagram filters). Those comments are otherwise invisible: never
 * replied to, never DM'd.
 *
 * This sweep is deliberately narrow. For each active campaign it looks only at
 * that campaign's post, only at recent comments, and acts on a comment ONLY when
 * both are true:
 *   1. the comment matches the campaign keyword, and
 *   2. the account owner has not already replied to it.
 * The reply check reads the comment's actual replies on Instagram, so a comment
 * you (or the tool) already answered is skipped — the poll never re-touches
 * handled comments. Each sweep is capped so it can never flood the comment API
 * (which Instagram rate-limits aggressively, error 368).
 *
 * It runs on an interval in the worker process because Vercel's free crons only
 * fire once a day. Matching and sending reuse the worker's processComment, so
 * rate limiting and logging behave exactly as for webhook-delivered comments.
 *
 * Known limitation, handled not fixed: comments removed by Instagram's Hidden
 * Words / spam filter may not be returned by the Graph API at all. Disable that
 * filter on the account to widen results.
 */

import { MAX_COMMENT_SEND_ATTEMPTS, SCHEDULED_RETRY_MARK } from "@/lib/queue/comment-delivery";
import { hasLegacyUnconfirmedDelivery } from "@/lib/instagram/delivery-errors";
import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import {
  getRecentMediaComments,
  getUserMedia,
  MetaApiError,
  type InstagramComment,
} from "@/lib/instagram/provider";
import {
  createInstagramContext,
  type InstagramContext,
} from "@/lib/instagram/provider";
import { matchKeywords } from "@/lib/utils/keyword-matcher";

function withThreadReplies(comments: InstagramComment[], sinceMs: number): InstagramComment[] {
  const out = [...comments];
  const seen = new Set(comments.map((c) => c.id));
  for (const comment of comments) {
    for (const reply of comment.replies?.data ?? []) {
      if (seen.has(reply.id) || !reply.timestamp) continue;
      if (Date.parse(reply.timestamp) < sinceMs) continue;
      seen.add(reply.id);
      out.push({ id: reply.id, text: reply.text ?? "", from: reply.from, timestamp: reply.timestamp });
    }
  }
  return out;
}

// A private reply whose delivery was left unconfirmed (the worker stopped
// mid-send, e.g. during a redeploy) is safe to try again after a while:
// Instagram allows one private reply per comment, so a repeat either
// delivers the one that was lost or is refused.
const UNCONFIRMED_RETRY_AFTER_MS = 30 * 60 * 1000;

// A comment the worker already re-queued with a delay (paced, throttled or
// over the hourly cap) has a job waiting; queueing another would only pile
// up copies. Trusted for a little over the longest delay, in case that job
// was lost.
const SCHEDULED_RETRY_TRUST_MS = 26 * 60 * 60 * 1000;
function hasScheduledRetry(log: {
  status: string;
  errorMessage: string | null;
  updatedAt: Date;
}): boolean {
  return (
    log.status === "PENDING" &&
    Boolean(log.errorMessage?.startsWith(SCHEDULED_RETRY_MARK)) &&
    Date.now() - log.updatedAt.getTime() < SCHEDULED_RETRY_TRUST_MS
  );
}

// Instagram allows a private reply up to 7 days after the comment, so the
// sweep looks back that far: a campaign set up days after the post still
// reaches everyone who commented. Older comments would only fail. An env
// value can shorten it, never stretch it past the 7 days.
const PRIVATE_REPLY_WINDOW_HOURS = 7 * 24;
const LOOKBACK_HOURS = Math.min(
  PRIVATE_REPLY_WINDOW_HOURS,
  Number(process.env.COMMENT_POLL_LOOKBACK_HOURS ?? PRIVATE_REPLY_WINDOW_HOURS)
);
// Hard cap on how many new comments a single campaign can enqueue per sweep, so
// a viral post drains gradually instead of bursting into the comment API.
const MAX_NEW_PER_SWEEP = Number(process.env.COMMENT_POLL_MAX_PER_SWEEP ?? 30);
// Comments read per post per sweep (Meta pages them 50 at a time).
const MAX_COMMENTS_PER_MEDIA = 5000;
// For "any post" campaigns, how many recent posts to scan.
const RECENT_MEDIA_LIMIT = 10;

interface SweepStat {
  campaign: string;
  keywords: string;
  matched: number;
  alreadyReplied: number;
  enqueued: number;
  errors: string[];
}

function errMessage(error: unknown): string {
  if (error instanceof MetaApiError)
    return `Meta ${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

/** One reconciliation pass across every active campaign. */
export async function reconcileComments(): Promise<void> {
  const automations = await prisma.automation.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      postId: true,
      matchAnyPost: true,
      matchAnyWord: true,
      keywords: true,
      wholeWordMatch: true,
      publicReplyEnabled: true,
      workspaceId: true,
      instagramAccount: {
        select: {
          id: true,
          instagramId: true,
          username: true,
          accessToken: true,
          provider: true,
          workspaceId: true,
          zernioAccountId: true,
        },
      },
    },
  });

  const sinceMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
  const tokenCache = new Map<string, InstagramContext | null>();

  for (const automation of automations) {
    const stat = await sweepCampaign({
      automation: automation,
      sinceMs: sinceMs,
      tokenCache: tokenCache,
    }).catch(
      (error): SweepStat => ({
        campaign: automation.name,
        keywords: automation.keywords.join(","),
        matched: 0,
        alreadyReplied: 0,
        enqueued: 0,
        errors: [errMessage(error)],
      })
    );
    await recordSweep(automation.workspaceId, stat);
  }
}

async function sweepCampaign({
  automation,
  sinceMs,
  tokenCache,
}: {
  automation: {
    id: string;
    name: string;
    postId: string | null;
    matchAnyPost: boolean;
    matchAnyWord: boolean;
    keywords: string[];
    wholeWordMatch: boolean;
    publicReplyEnabled: boolean;
    instagramAccount: {
      id: string;
      instagramId: string;
      username: string;
      accessToken: string;
      provider: "META" | "ZERNIO";
      workspaceId: string;
      zernioAccountId: string | null;
    };
  };
  sinceMs: number;
  tokenCache: Map<string, InstagramContext | null>;
}): Promise<SweepStat> {
  const account = automation.instagramAccount;
  const stat: SweepStat = {
    campaign: automation.name,
    keywords: automation.matchAnyWord
      ? "(any word)"
      : automation.keywords.join(","),
    matched: 0,
    alreadyReplied: 0,
    enqueued: 0,
    errors: [],
  };

  // Decrypt the account token once per sweep.
  let accessToken = tokenCache.get(account.id);
  if (accessToken === undefined) {
    try {
      accessToken = await createInstagramContext(account);
    } catch {
      accessToken = null;
    }
    tokenCache.set(account.id, accessToken);
  }
  if (!accessToken) {
    stat.errors.push("Failed to decrypt access token");
    return stat;
  }

  // Which media this campaign covers: its own post, or the recent feed if it
  // matches any post.
  const mediaIds: string[] = [];
  if (automation.postId) {
    mediaIds.push(automation.postId);
    mediaIds.push(...(await adMediaFor(automation.postId)));
  } else if (automation.matchAnyPost) {
    try {
      const media = await getUserMedia({
        context: accessToken,
        limit: RECENT_MEDIA_LIMIT,
      });
      mediaIds.push(...media.map((m) => m.id));
    } catch (error) {
      stat.errors.push(`Media list: ${errMessage(error)}`);
    }
  }
  if (mediaIds.length === 0) return stat;

  const queue = getDMQueue();

  for (const mediaId of mediaIds) {
    let comments: InstagramComment[];
    try {
      comments = await getRecentMediaComments({
        context: accessToken,
        mediaId: mediaId,
        sinceMs: sinceMs,
        // A busy post easily passes 800 comments in its 7 days; the oldest
        // ones are the closest to the private-reply deadline, so read them all.
        max: MAX_COMMENTS_PER_MEDIA,
      });
    } catch (error) {
      stat.errors.push(`Comments ${mediaId}: ${errMessage(error)}`);
      continue;
    }

    // Replies under a comment are comments too: someone answering another
    // commenter with the keyword is owed the DM like everyone else.
    comments = withThreadReplies(comments, sinceMs);

    // Comments this campaign has already worked on. For these, a reply from
    // the account under the comment is usually the campaign's own public
    // reply, which says nothing about whether the DM went out.
    const known = new Set(
      (
        await prisma.dmLog.findMany({
          where: { automationId: automation.id, commentId: { in: comments.map((c) => c.id) } },
          select: { commentId: true },
        })
      ).map((log) => log.commentId)
    );

    // Keep only comments that aren't the account's own and match the keyword;
    // the campaign's DmLog decides below what is still to do.
    const needsAction = comments.filter((c) => {
      const authorId = c.from?.id;
      if (!authorId || authorId === account.instagramId) return false;

      const matched = automation.matchAnyWord
        ? true
        : matchKeywords(
            c.text ?? "",
            automation.keywords,
            automation.wholeWordMatch
          ).matched;
      if (!matched) return false;
      stat.matched += 1;

      const ownerReplied = (c.replies?.data ?? []).some(
        (r) => r.from?.id === account.instagramId
      );
      // Counted for the sweep report only: a reply from the account under
      // the comment (by hand, or a campaign's public reply) is not a DM, so
      // the comment still gets one. Each person gets it once per campaign
      // (personAlreadyServed in the worker).
      if (ownerReplied && !known.has(c.id)) stat.alreadyReplied += 1;
      return true;
    });
    if (needsAction.length === 0) continue;

    // Second guard against races: skip comments this campaign has already fully
    // handled. "Fully handled" depends on the campaign: if it posts a public
    // reply, the completion signal is publicReplySentAt (a DM alone is not
    // enough — the reply still has to land); otherwise a SENT DM is enough. This
    // is what lets a comment whose DM sent but whose public reply failed come
    // back and retry the reply.
    await prisma.dmLog.updateMany({
      where: {
        automationId: automation.id,
        commentId: { in: needsAction.map((c) => c.id) },
        status: { in: ["PENDING", "FAILED"] },
        dmDeliveryUnconfirmed: true,
        // Once only: a retry that comes back unconfirmed too (Instagram
        // answered "unknown error", which it also does for a second private
        // reply to the same comment) is left for a person to check.
        attempts: { lt: 2 },
        updatedAt: { lt: new Date(Date.now() - UNCONFIRMED_RETRY_AFTER_MS) },
      },
      data: { dmDeliveryUnconfirmed: false },
    });
    // A public reply left unconfirmed can be settled from the comment itself:
    // a reply by the account under it means it landed; none after a while
    // means it did not, and it may be posted again.
    const ownerRepliedTo = new Set(
      needsAction
        .filter((c) => (c.replies?.data ?? []).some((r) => r.from?.id === account.instagramId))
        .map((c) => c.id)
    );
    if (automation.publicReplyEnabled) {
      const unsettled = await prisma.dmLog.findMany({
        where: {
          automationId: automation.id,
          commentId: { in: needsAction.map((c) => c.id) },
          publicReplyDeliveryUnconfirmed: true,
          publicReplySentAt: null,
          updatedAt: { lt: new Date(Date.now() - UNCONFIRMED_RETRY_AFTER_MS) },
        },
        select: { commentId: true },
      });
      for (const { commentId } of unsettled) {
        await prisma.dmLog.update({
          where: { automationId_commentId: { automationId: automation.id, commentId } },
          data: ownerRepliedTo.has(commentId)
            ? { publicReplySentAt: new Date(), publicReplyDeliveryUnconfirmed: false }
            : { publicReplyDeliveryUnconfirmed: false },
        });
      }
    }
    const logs = await prisma.dmLog.findMany({
      where: {
        automationId: automation.id,
        commentId: { in: needsAction.map((c) => c.id) },
      },
      select: {
        commentId: true, status: true, attempts: true, errorMessage: true, updatedAt: true,
        dmDeliveryUnconfirmed: true, publicReplySentAt: true,
        publicReplyDeliveryUnconfirmed: true,
      },
    });
    const handledSet = new Set(logs.filter((log) => {
      // SKIPPED_DEDUP: the person (or this comment, through another
      // campaign) already got the DM; sweeping it again would only take a
      // slot from someone still waiting.
      const dmStopped = log.status === "SENT" || log.status === "SKIPPED_PLAN_LIMIT" ||
        log.status === "SKIPPED_DEDUP" ||
        log.dmDeliveryUnconfirmed || log.attempts >= MAX_COMMENT_SEND_ATTEMPTS ||
        hasScheduledRetry(log) ||
        (log.status === "FAILED" && hasLegacyUnconfirmedDelivery(log.errorMessage));
      // The public reply only goes out with (after) a sent DM, so a comment
      // without one owes no public reply on its own.
      const replyStopped = !automation.publicReplyEnabled ||
        log.publicReplySentAt || log.publicReplyDeliveryUnconfirmed ||
        log.status !== "SENT";
      return dmStopped && replyStopped;
    }).map((log) => log.commentId));

    // Comments that still need their DM come first, oldest first; a comment
    // that only owes its public reply waits behind them, so a backlog of
    // public replies never takes the sweep's slots from someone without a DM.
    const dmSent = new Set(
      logs.filter((log) => log.status === "SENT").map((log) => log.commentId)
    );
    const fresh = needsAction
      .filter((c) => !handledSet.has(c.id))
      .sort(
        (a, b) =>
          Number(dmSent.has(a.id)) - Number(dmSent.has(b.id)) ||
          Date.parse(a.timestamp) - Date.parse(b.timestamp)
      )
      .slice(0, MAX_NEW_PER_SWEEP);

    for (const c of fresh) {
      // No deterministic jobId here: a retained completed/failed job from an
      // earlier sweep would otherwise be treated as a duplicate and silently
      // drop this add, so the comment would never be retried. Dedup is handled
      // above and by the worker's atomic, durable per-leg claims. Send attempts
      // are counted in DmLog across jobs, so a sweep cannot reset the budget.
      await queue.add("process-comment", {
        instagramAccountId: account.instagramId,
        accountConnectionId: account.id,
        commentId: c.id,
        commentText: c.text ?? "",
        commenterId: c.from!.id,
        commenterName: c.from?.username,
        mediaId,
        // When the sweep is looking at an ad, the campaign is bound to the post
        // the ad was made from: without this the worker matches nothing and
        // drops the comment, so the sweep would enqueue it again every five
        // minutes and never deliver it.
        originalMediaId:
          automation.postId && mediaId !== automation.postId
            ? automation.postId
            : undefined,
        source: "POLLING",
      });
      stat.enqueued += 1;
    }
  }

  return stat;
}

/**
 * Ad copies of a post, as seen in webhooks already received.
 *
 * Boosting a post gives it a second media id: comments left on the ad arrive
 * with the ad's `media.id` and the post's id in `original_media_id`. The sweep
 * would otherwise only ever look at the post itself, so a comment Meta fails to
 * deliver on the ad is lost for good — exactly the case this safety net exists
 * for, and the one where volume is highest.
 *
 * The ad ids are recovered from the webhooks themselves rather than from the
 * ads API, which would need ads_management on top of the permissions the app
 * already asks for. The trade-off: an ad becomes visible to the sweep only once
 * a single comment on it has arrived. That is enough for the failure being
 * covered here, where some webhooks arrive and others do not.
 */
export async function adMediaFor(postId: string): Promise<string[]> {
  try {
    const rows = await prisma.$queryRaw<{ mediaId: string | null }[]>`
      SELECT DISTINCT change->'value'->'media'->>'id' AS "mediaId"
      FROM "WebhookEvent" w,
           jsonb_array_elements(w.payload::jsonb->'entry') entry,
           jsonb_array_elements(entry->'changes') change
      WHERE change->>'field' = 'comments'
        AND change->'value'->'media'->>'original_media_id' = ${postId}
        AND w."createdAt" > now() - interval '90 days'
    `;
    return rows
      .map((r) => r.mediaId)
      .filter((id): id is string => Boolean(id) && id !== postId);
  } catch {
    // A failure here must not stop the sweep: the post itself is still checked.
    return [];
  }
}

async function recordSweep(
  workspaceId: string,
  stat: SweepStat
): Promise<void> {
  // Only log when something happened or something went wrong.
  if (stat.enqueued === 0 && stat.errors.length === 0) return;

  await prisma.operationalEvent
    .create({
      data: {
        workspaceId,
        source: "SYSTEM",
        level: stat.errors.length > 0 ? "WARNING" : "INFO",
        message: `Comment sweep "${stat.campaign}" [${stat.keywords}]: ${stat.enqueued} enqueued, ${stat.matched} matched, ${stat.alreadyReplied} already replied`,
        payload: { ...stat },
      },
    })
    .catch(() => {});
}
