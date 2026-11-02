import { getRedisConnection } from "@/lib/queue/client";

// While Instagram refuses an account's token, its jobs wait instead of failing.
// The flag runs out by itself so one job tries again every half hour: a reconnect
// clears it at once, and a wrong flag can never stop an account for good.
const PAUSE_SECONDS = 30 * 60;
export const TOKEN_PAUSE_RECHECK_MS = 10 * 60_000;

// Thrown by work that must wait for the token; its queue holds the job.
export class TokenPausedError extends Error {}

const key = (instagramId: string) => `token-invalid:${instagramId}`;

export async function markTokenInvalid(instagramId: string): Promise<void> {
  await getRedisConnection().set(key(instagramId), "1", "EX", PAUSE_SECONDS);
}

export async function clearTokenInvalid(instagramId: string): Promise<void> {
  await getRedisConnection().del(key(instagramId));
}

export async function isTokenInvalid(instagramId: string): Promise<boolean> {
  return (await getRedisConnection().get(key(instagramId))) !== null;
}
