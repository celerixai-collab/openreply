import {
  MetaApiError,
  RateLimitError,
  TokenExpiredError,
} from "@/lib/meta/client";
import {
  ZernioApiError,
  ZernioDeliveryUnconfirmedError,
} from "@/lib/zernio/client";

export class DeliveryUnconfirmedError extends Error {
  constructor(error: unknown) {
    const detail =
      error instanceof Error ? error.message : "Unknown send outcome";
    super(
      `Message delivery is unconfirmed; automatic retries stopped. Inspect the Instagram inbox before retrying. ${detail}`,
    );
    this.name = "DeliveryUnconfirmedError";
  }
}

export function isDeliveryUnconfirmed(
  error: unknown,
): error is DeliveryUnconfirmedError | ZernioDeliveryUnconfirmedError {
  return (
    error instanceof DeliveryUnconfirmedError ||
    error instanceof ZernioDeliveryUnconfirmedError
  );
}

// Only explicit rejections prove that no message was delivered. Meta code 1,
// network failures, invalid responses and local persistence failures do not.
export function isConfirmedSendRejection(error: unknown): boolean {
  if (error instanceof RateLimitError || error instanceof TokenExpiredError)
    return true;
  if (error instanceof ZernioApiError)
    return error.code >= 400 && error.code < 500;
  return (
    error instanceof MetaApiError && [10, 100, 200, 551].includes(error.code)
  );
}

/**
 * Instagram pushing back on volume rather than on this one message: its rate
 * limits, and the "thread does not exist" rejection (code 100, subcode
 * 2534001) it returned for about half of all private replies once an account
 * had sent a few hundred in half an hour (2026-10-20). Both are confirmed
 * rejections, so nothing was delivered and the send may be repeated later.
 */
export function isInstagramThrottle(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  return (
    error instanceof MetaApiError &&
    (error.subcode === 2534001 ||
      /\bsub=2534001\b|thread does not exist/i.test(error.message))
  );
}

export function classifySendError(error: unknown): unknown {
  return isDeliveryUnconfirmed(error) || isConfirmedSendRejection(error)
    ? error
    : new DeliveryUnconfirmedError(error);
}

// Old workers logged these uncertain Meta responses as retryable failures.
export function hasLegacyUnconfirmedDelivery(
  error: string | null | undefined,
): boolean {
  return Boolean(
    error &&
    /(?:MetaApiError (?:1|2|5\d\d):|\[code=(?:1|2|5\d\d)\b)/.test(error),
  );
}
