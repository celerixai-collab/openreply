-- One-off data fix (2026-10-20): Instagram throttled the account while the
-- two "剪輯室 早鳥等候" campaigns caught up on days of comments, and about a
-- hundred private replies were refused with "thread does not exist" (code
-- 100, subcode 2534001) and given up after three quick retries. Nothing was
-- delivered to them, and Instagram still allows the private reply (7 days
-- from the comment), so hand them back to the reconciler, which re-sends
-- them at the new paced rate.
UPDATE "DmLog"
SET "status" = 'PENDING',
    "attempts" = 0,
    "dmDeliveryUnconfirmed" = false,
    "errorMessage" = 'Re-queued after Instagram throttling on 2026-10-20'
WHERE "automationId" IN ('cmvgv55ce000208l5mzi3maff', 'cmvgv5uv6000307jybnpiejoe')
  AND "status" = 'FAILED'
  AND "commentId" NOT LIKE 'reveal:%'
  AND "errorMessage" LIKE '%thread does not exist%'
  AND "createdAt" > NOW() - INTERVAL '7 days';
