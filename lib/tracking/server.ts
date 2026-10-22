import { createHash, createHmac, randomBytes } from "node:crypto";

export function generateTrackedLinkSlug() {
  return randomBytes(7).toString("base64url");
}

export function hashClickIp(ipAddress: string | null | undefined) {
  if (!ipAddress) return null;

  const salt = process.env.NEXTAUTH_SECRET ?? "campaigncue-click-salt";
  return createHash("sha256").update(`${salt}:${ipAddress}`).digest("hex");
}

/**
 * Token added to a recipient's tracked links (`?r=`), so repeat taps by one
 * person count as one click. Keyed, so the URL never exposes the
 * Instagram-scoped ID itself.
 */
export function hashRecipientId(recipientId: string) {
  return hashRecipientIdWith(process.env.NEXTAUTH_SECRET ?? DEFAULT_CLICK_SALT, recipientId);
}

/** The salt used when NEXTAUTH_SECRET is not set (e.g. on a worker host). */
export const DEFAULT_CLICK_SALT = "campaigncue-click-salt";

export function hashRecipientIdWith(secret: string, recipientId: string) {
  return createHmac("sha256", secret)
    .update(`recipient:${recipientId}`)
    .digest("base64url")
    .slice(0, 22);
}

/** Accepts only tokens shaped like `hashRecipientId` output; anything else is ignored. */
export function parseRecipientToken(value: string | null) {
  if (!value) return null;
  return /^[A-Za-z0-9_-]{22}$/.test(value) ? value : null;
}

export function getRequestIp(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() ?? null;
  }

  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("cf-connecting-ip") ??
    null
  );
}
