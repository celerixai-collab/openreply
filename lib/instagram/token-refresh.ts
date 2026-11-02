import { prisma } from "@/lib/db/client";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import { refreshLongLivedToken } from "@/lib/meta/client";
import { clearTokenInvalid } from "@/lib/queue/token-pause";

// Instagram extends a token that is at least a day old by another 60 days, with
// no login. Renewing once a month leaves a month to notice one that stops working.
const RENEW_WHEN_DAYS_LEFT = 30;

export type TokenRefreshResult = {
  instagramAccountId: string;
  username: string;
  status: "refreshed" | "failed";
  error?: string;
};

/**
 * Renew Instagram tokens that are a month old. Called by the cron
 * route and by the worker: a token that runs out stops every campaign, so this
 * must not depend on one scheduler alone.
 */
export async function refreshExpiringTokens(): Promise<TokenRefreshResult[]> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() + RENEW_WHEN_DAYS_LEFT);

  const accountsToRefresh = await prisma.instagramAccount.findMany({
    where: {
      accessToken: { not: "" },
      provider: "META",
      tokenExpiresAt: {
        not: null,
        lte: cutoffDate,
      },
    },
    select: {
      id: true,
      workspaceId: true,
      username: true,
      instagramId: true,
      accessToken: true,
    },
  });

  const results: TokenRefreshResult[] = [];

  for (const account of accountsToRefresh) {
    try {
      const currentToken = decryptToken(account.accessToken);
      const { accessToken: newToken, expiresIn } =
        await refreshLongLivedToken(currentToken);
      const encryptedToken = encryptToken(newToken);
      const newExpiry = new Date(Date.now() + expiresIn * 1000);

      await prisma.instagramAccount.update({
        where: { id: account.id },
        data: {
          accessToken: encryptedToken,
          tokenExpiresAt: newExpiry,
        },
      });

      await clearTokenInvalid(account.instagramId);

      results.push({
        instagramAccountId: account.id,
        username: account.username,
        status: "refreshed",
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      await prisma.operationalEvent.create({
        data: {
          workspaceId: account.workspaceId,
          source: "TOKEN_REFRESH",
          level: "ERROR",
          message: `Token refresh failed for @${account.username}: ${errorMessage}`,
          payload: {
            instagramAccountId: account.id,
            username: account.username,
          },
        },
      });

      results.push({
        instagramAccountId: account.id,
        username: account.username,
        status: "failed",
        error: errorMessage,
      });
    }
  }

  return results;
}
