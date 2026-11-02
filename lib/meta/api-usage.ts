// What the Instagram quota is spent on, logged by the worker. Without this a limit
// can only be guessed at: on 2026-11-02 "too many DMs" turned out to be the app's
// whole allowance, reads included.
const calls = new Map<string, number>();
let appUsage: string | null = null;
let accountUsage: string | null = null;

export function noteApiCall(response: Response): void {
  let kind = "other";
  try {
    const last = new URL(response.url).pathname.split("/").pop() ?? "";
    kind = /^\d+$/.test(last) ? "object" : last || "other";
  } catch {}
  calls.set(kind, (calls.get(kind) ?? 0) + 1);
  appUsage = response.headers.get("x-app-usage") ?? appUsage;
  accountUsage = response.headers.get("x-business-use-case-usage") ?? accountUsage;
}

/** The calls made since the last report, and the latest usage Instagram reported. */
export function takeApiUsageReport(): string | null {
  if (calls.size === 0) return null;
  const counts = JSON.stringify(Object.fromEntries(calls));
  calls.clear();
  return `calls=${counts} app=${appUsage ?? "-"} account=${accountUsage ?? "-"}`;
}
