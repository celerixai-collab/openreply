import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const keys = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  return {
    keys,
    hashes,
    redis: {
      get: vi.fn(async (key: string) => keys.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        keys.set(key, value);
        return "OK";
      }),
      exists: vi.fn(async (key: string) => (keys.has(key) ? 1 : 0)),
      hgetall: vi.fn(async (key: string) => hashes.get(key) ?? {}),
      hset: vi.fn(async (key: string, value: Record<string, string>) => {
        hashes.set(key, { ...(hashes.get(key) ?? {}), ...value });
        return 1;
      }),
    },
    prisma: {
      instagramAccount: { findFirst: vi.fn(), findUnique: vi.fn() },
      aiAssistant: { findUnique: vi.fn() },
      contact: { findFirst: vi.fn() },
      aiDraft: { findFirst: vi.fn() },
    },
    queueAdd: vi.fn(),
    send: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: h.prisma }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => h.redis }));
vi.mock("@/lib/instagram/context", () => ({
  createInstagramContext: vi.fn(async () => ({ provider: "META", accessToken: "token" })),
  hasInstagramCredentials: () => true,
}));
vi.mock("@/lib/instagram/send-messages", () => ({ sendDirectMessage: h.send }));
vi.mock("@/lib/ai/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/queue")>()),
  getAiQueue: () => ({ add: h.queueAdd }),
}));

import { nudgeDelays, processAiNudge, scheduleNudgesAfterMessage, setNudgeSettings } from "../lib/ai/nudges";

const HOUR = 3_600_000;
const MESSAGES = ["剪輯系統上線了，你開始剪了嗎？", "你還在等什麼呢？", "不要再等了", "趕快開始上課吧"];

beforeEach(async () => {
  vi.clearAllMocks();
  h.keys.clear();
  h.hashes.clear();
  h.prisma.instagramAccount.findFirst.mockResolvedValue({ id: "acct_1", aiAssistant: { enabled: true } });
  h.prisma.instagramAccount.findUnique.mockResolvedValue({ id: "acct_1", instagramId: "ig_1" });
  h.prisma.aiAssistant.findUnique.mockResolvedValue({ enabled: true, testUsernames: [] });
  h.prisma.aiDraft.findFirst.mockResolvedValue(null);
  await setNudgeSettings("acct_1", { enabled: true, intervalHours: 5, messages: MESSAGES });
});

describe("nudgeDelays", () => {
  it("fits four nudges every 5 hours, but only three every 6, inside the 24-hour window", () => {
    expect(nudgeDelays(5, 4).map((ms) => ms / HOUR)).toEqual([5, 10, 15, 20]);
    expect(nudgeDelays(6, 4).map((ms) => ms / HOUR)).toEqual([6, 12, 18]);
  });
});

describe("nudges", () => {
  it("schedules the first nudge 5 hours after their message", async () => {
    await scheduleNudgesAfterMessage("ig_1", "fan_1");
    expect(h.queueAdd).toHaveBeenCalledWith(
      "ai-nudge",
      expect.objectContaining({ accountId: "acct_1", igsid: "fan_1", step: 0 }),
      expect.objectContaining({ delay: 5 * HOUR })
    );
  });

  it("does nothing while nudges are off", async () => {
    await setNudgeSettings("acct_1", { enabled: false, intervalHours: 5, messages: MESSAGES });
    await scheduleNudgesAfterMessage("ig_1", "fan_1");
    expect(h.queueAdd).not.toHaveBeenCalled();
  });

  it("sends the step's message and schedules the next one", async () => {
    const since = Date.now() - 5 * HOUR;
    h.keys.set("ai:nudge-since:acct_1:fan_1", String(since));

    await expect(processAiNudge({ accountId: "acct_1", igsid: "fan_1", since, step: 0 })).resolves.toBe("sent");
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ userId: "fan_1", message: MESSAGES[0] }));
    const [, next, opts] = h.queueAdd.mock.calls[0];
    expect(next).toMatchObject({ step: 1, since });
    expect(opts.delay).toBeGreaterThan(4.9 * HOUR);
  });

  it("stops after the last nudge that fits the window", async () => {
    const since = Date.now() - 20 * HOUR;
    h.keys.set("ai:nudge-since:acct_1:fan_1", String(since));
    await expect(processAiNudge({ accountId: "acct_1", igsid: "fan_1", since, step: 3 })).resolves.toBe("sent");
    expect(h.queueAdd).not.toHaveBeenCalled();
  });

  it("skips a nudge when they wrote again, bought, or the creator took over", async () => {
    const since = Date.now() - 5 * HOUR;
    const job = { accountId: "acct_1", igsid: "fan_1", since, step: 0 };

    h.keys.set("ai:nudge-since:acct_1:fan_1", String(since + 1000));
    await expect(processAiNudge(job)).resolves.toBe("skipped");

    h.keys.set("ai:nudge-since:acct_1:fan_1", String(since));
    h.keys.set("ai:ended:acct_1:fan_1", "1");
    await expect(processAiNudge(job)).resolves.toBe("skipped");

    h.keys.delete("ai:ended:acct_1:fan_1");
    h.keys.set("ai:paused:acct_1:fan_1", "1");
    await expect(processAiNudge(job)).resolves.toBe("skipped");

    expect(h.send).not.toHaveBeenCalled();
  });

  it("skips a nudge once the 24-hour window has closed", async () => {
    const since = Date.now() - 24 * HOUR;
    h.keys.set("ai:nudge-since:acct_1:fan_1", String(since));
    await expect(processAiNudge({ accountId: "acct_1", igsid: "fan_1", since, step: 3 })).resolves.toBe("skipped");
    expect(h.send).not.toHaveBeenCalled();
  });
});
