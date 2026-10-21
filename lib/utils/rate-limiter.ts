/**
 * Rate Limiter
 *
 * Redis-based rate limiter for Instagram private replies.
 *
 * The cap matches Meta's documented limit for this exact call: 750 private
 * replies per hour per Instagram professional account, for comments on posts
 * and reels. Exceeding it risks 429s and app-level restrictions, so the worker
 * requeues rather than pushing through.
 * https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
 *
 * Note this is a hard ceiling with no headroom. If Meta throttles before the
 * documented limit, or other calls on the same account share the bucket, lower
 * this value.
 */

import Redis from "ioredis";

const RATE_LIMIT_MAX = 750; // private replies per hour, per Meta's documented cap
const RATE_LIMIT_WINDOW = 3600; // 1 hour in seconds
const REQUEUE_DELAY_MS = 30 * 60 * 1000; // 30 minutes
const MAX_REQUEUE_ATTEMPTS = 3;

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null, // required by BullMQ
    });
  }
  return redis;
}

export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  remainingDMs: number;
  shouldRequeue: boolean;
  requeueDelayMs: number;
  shouldSkip: boolean;
  reserved: boolean;
}

const RESERVE_DM_SLOT_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local max = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

if current >= max then
  return {0, current, 0}
end

local next_count = redis.call("INCR", KEYS[1])
if next_count == 1 then
  redis.call("EXPIRE", KEYS[1], ttl)
end

return {1, next_count, max - next_count}
`;

function toScriptNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10);
  return 0;
}

function blockedResult(
  count: number,
  requeueAttempt: number
): RateLimitResult {
  if (requeueAttempt >= MAX_REQUEUE_ATTEMPTS) {
    return {
      allowed: false,
      currentCount: count,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    };
  }

  return {
    allowed: false,
    currentCount: count,
    remainingDMs: 0,
    shouldRequeue: true,
    requeueDelayMs: REQUEUE_DELAY_MS,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Check if an Instagram account is within its DM rate limit.
 *
 * Uses a Redis counter with a 1-hour TTL per account.
 * Key pattern: `rate:dm:{instagramAccountId}`
 *
 * @param instagramAccountId - The Instagram account ID to check
 * @param requeueAttempt - How many times this job has been requeued (0 = first attempt)
 * @returns Rate limit result with action recommendations
 */
export async function checkRateLimit(
  instagramAccountId: string,
  requeueAttempt: number = 0
): Promise<RateLimitResult> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;

  const currentCount = await client.get(key);
  const count = currentCount ? parseInt(currentCount, 10) : 0;

  if (count >= RATE_LIMIT_MAX) {
    // Over the limit
    if (requeueAttempt >= MAX_REQUEUE_ATTEMPTS) {
      // Exceeded max requeue attempts — skip this DM
      return {
        allowed: false,
        currentCount: count,
        remainingDMs: 0,
        shouldRequeue: false,
        requeueDelayMs: 0,
        shouldSkip: true,
        reserved: false,
      };
    }

    return {
      allowed: false,
      currentCount: count,
      remainingDMs: 0,
      shouldRequeue: true,
      requeueDelayMs: REQUEUE_DELAY_MS,
      shouldSkip: false,
      reserved: false,
    };
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: RATE_LIMIT_MAX - count,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Atomically reserve a DM send slot for an Instagram account.
 * This is the worker-safe path; it prevents concurrent jobs from all passing
 * the rate-limit check before any of them increments the Redis counter.
 */
export async function reserveDMSlot(
  instagramAccountId: string,
  requeueAttempt: number = 0
): Promise<RateLimitResult> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;

  const result = await client.eval(
    RESERVE_DM_SLOT_SCRIPT,
    1,
    key,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW
  );
  const values = Array.isArray(result) ? result : [];
  const allowedFlag = toScriptNumber(values[0]);
  const count = toScriptNumber(values[1]);
  const remaining = toScriptNumber(values[2]);

  if (allowedFlag !== 1) {
    return blockedResult(count, requeueAttempt);
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: remaining,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  };
}

/**
 * Release a DM slot previously taken by reserveDMSlot.
 *
 * reserveDMSlot increments the hourly counter before the send, so concurrent
 * jobs can't all pass the check at once. When that send then fails (closed
 * messaging window, expired token, rejected reply) the reserved slot is never
 * used and must be handed back. Otherwise a comment that never delivers a DM
 * still burns one slot per attempt, and BullMQ's retries burn several. On a
 * post with many failing sends the counter inflates past the real number of
 * DMs and legitimate replies get skipped as rate-limited until the TTL expires.
 *
 * DECR is atomic and preserves the key's TTL, so the hourly window still resets
 * when it originally would. A missing key (the window already rolled over)
 * would decrement to -1 with no expiry, so that case is clamped back to zero.
 */
export async function releaseDMSlot(
  instagramAccountId: string
): Promise<number> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  const next = await client.decr(key);
  if (next < 0) {
    await client.del(key);
    return 0;
  }
  return next;
}

/**
 * Backwards-compatible helper for tests and admin scripts.
 * Prefer reserveDMSlot in workers.
 */
export async function incrementDMCounter(
  instagramAccountId: string
): Promise<number> {
  const result = await reserveDMSlot(instagramAccountId, MAX_REQUEUE_ATTEMPTS);
  return result.currentCount;
}

/**
 * Get the current DM count for an Instagram account.
 */
export async function getCurrentDMCount(
  instagramAccountId: string
): Promise<number> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  const count = await client.get(key);
  return count ? parseInt(count, 10) : 0;
}

/**
 * Reset the rate limiter for an account (useful for testing).
 */
export async function resetRateLimit(
  instagramAccountId: string
): Promise<void> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  await client.del(key);
}

// Export constants for use in tests
export { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW, REQUEUE_DELAY_MS, MAX_REQUEUE_ATTEMPTS };

// ─── Pacing and throttle cooldown ──────────────────────────────────────────────
//
// The hourly cap above is Meta's documented ceiling, but Instagram starts
// rejecting private replies long before it: on 2026-10-20 an account that
// sent about 450 in 30 minutes (a backlog of days-old comments, caught up all
// at once) had half of the next ones refused. So private replies are also
// paced per minute, and a run of throttle errors pauses the account's sends
// for a while instead of retrying into the wall.

const PACE_PER_MINUTE = Number(process.env.DM_PACE_PER_MINUTE ?? 6);
const THROTTLE_COOLDOWN_MS = Number(
  process.env.DM_THROTTLE_COOLDOWN_MS ?? 15 * 60 * 1000
);
// A few throttle errors close together trip the cooldown; a single one may
// be about that one person, and must not stop everyone else.
const THROTTLE_TRIP_COUNT = 3;
const THROTTLE_TRIP_WINDOW_SECONDS = 120;

function jitterMs(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}

const TAKE_PACE_SLOT_SCRIPT = `
local used = tonumber(redis.call("GET", KEYS[1]) or "0")
if used >= tonumber(ARGV[1]) then
  return 0
end
local next_used = redis.call("INCR", KEYS[1])
if next_used == 1 then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
end
return 1
`;

export type PaceResult = { allowed: true } | { allowed: false; retryInMs: number };

/**
 * Take one private-reply slot for this minute, unless the account is cooling
 * down after Instagram throttled it. A refusal says when to try again, with
 * jitter so the waiting jobs do not all wake at once.
 */
export async function reservePaceSlot(instagramAccountId: string): Promise<PaceResult> {
  const client = getRedis();
  const cooldownLeft = await client.pttl(`cooldown:dm:${instagramAccountId}`);
  if (cooldownLeft > 0) {
    return { allowed: false, retryInMs: cooldownLeft + jitterMs(5 * 60_000) };
  }
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  const slotKey = `pace:dm:${instagramAccountId}:${minute}`;
  const waitKey = `pace:wait:${instagramAccountId}:${minute}`;
  // Only a granted slot counts against the minute: a refused job must not
  // use up a slot it never got, or a long queue lets almost nothing through.
  const granted = toScriptNumber(
    await client.eval(TAKE_PACE_SLOT_SCRIPT, 1, slotKey, PACE_PER_MINUTE, 120)
  );
  if (granted === 1) return { allowed: true };
  // How many jobs were turned away this minute spreads them over that many
  // minutes ahead, so they do not all come back at once.
  const waiting = await client.incr(waitKey);
  if (waiting === 1) await client.expire(waitKey, 120);
  const backlogMinutes = Math.ceil(waiting / PACE_PER_MINUTE);
  const nextMinute = (minute + 1) * 60_000 - now;
  return {
    allowed: false,
    retryInMs: nextMinute + jitterMs(Math.max(1, backlogMinutes) * 60_000),
  };
}

/**
 * Note a throttle error. Returns true when it tripped the cooldown, which
 * holds every private reply from this account for the next while.
 */
export async function recordThrottle(instagramAccountId: string): Promise<boolean> {
  const client = getRedis();
  const key = `throttle:dm:${instagramAccountId}`;
  const count = await client.incr(key);
  if (count === 1) await client.expire(key, THROTTLE_TRIP_WINDOW_SECONDS);
  if (count < THROTTLE_TRIP_COUNT) return false;
  await client.set(`cooldown:dm:${instagramAccountId}`, "1", "PX", THROTTLE_COOLDOWN_MS);
  await client.del(key);
  return true;
}

// How long a throttled comment waits before its next try: growing, and in
// total well inside Instagram's 7 days for a private reply.
const THROTTLE_RETRY_DELAYS_MS = [
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
  8 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
];
export const MAX_THROTTLE_RETRIES = THROTTLE_RETRY_DELAYS_MS.length;

export function throttleRetryDelayMs(retry: number): number {
  const base = THROTTLE_RETRY_DELAYS_MS[Math.min(retry, THROTTLE_RETRY_DELAYS_MS.length - 1)];
  return base + jitterMs(5 * 60_000);
}

// ─── Public comment replies ─────────────────────────────────────────────────────
//
// Public replies hit Instagram's spam limit (368) on 2026-10-20 after a few
// hundred in half an hour. They are paced on their own, slower than DMs, and
// a 368 pauses them for a while; a reply held back now is posted on a later
// sweep, since its DmLog still owes it.

const PUBLIC_PACE_PER_MINUTE = Number(process.env.PUBLIC_REPLY_PACE_PER_MINUTE ?? 2);
const PUBLIC_COOLDOWN_MS = Number(
  process.env.PUBLIC_REPLY_COOLDOWN_MS ?? 30 * 60 * 1000
);

/** Take one public-reply slot for this minute, unless replies are paused. */
export async function reservePublicReplySlot(instagramAccountId: string): Promise<boolean> {
  const client = getRedis();
  if ((await client.pttl(`cooldown:public:${instagramAccountId}`)) > 0) return false;
  const minute = Math.floor(Date.now() / 60_000);
  const granted = toScriptNumber(
    await client.eval(
      TAKE_PACE_SLOT_SCRIPT,
      1,
      `pace:public:${instagramAccountId}:${minute}`,
      PUBLIC_PACE_PER_MINUTE,
      120
    )
  );
  return granted === 1;
}

/** Instagram refused a public reply for volume: pause them for a while. */
export async function pausePublicReplies(instagramAccountId: string): Promise<void> {
  await getRedis().set(`cooldown:public:${instagramAccountId}`, "1", "PX", PUBLIC_COOLDOWN_MS);
}
