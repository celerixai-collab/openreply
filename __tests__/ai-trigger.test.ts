import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockQueueAdd, redis } = vi.hoisted(() => {
  const lists = new Map<string, string[]>();
  return {
    mockPrisma: {
      instagramAccount: { findFirst: vi.fn() },
      aiDraft: { findUnique: vi.fn() },
    },
    mockQueueAdd: vi.fn(),
    redis: {
      lists,
      lrange: vi.fn(async (key: string) => [...(lists.get(key) ?? [])]),
      rpush: vi.fn(async (key: string, value: string) => {
        lists.set(key, [...(lists.get(key) ?? []), value]);
      }),
      ltrim: vi.fn(async (key: string, start: number, stop: number) => {
        const list = lists.get(key) ?? [];
        const from = start < 0 ? Math.max(0, list.length + start) : start;
        const to = stop < 0 ? list.length + stop : stop;
        lists.set(key, list.slice(from, to + 1));
      }),
      expire: vi.fn(),
    },
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => redis }));
vi.mock("@/lib/ai/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/queue")>()),
  getAiQueue: () => ({ add: mockQueueAdd }),
}));

import { maybeEnqueueAiDraft, readBurst, clearBurstThrough } from "../lib/ai/trigger";
import { aiDraftJobId } from "../lib/ai/queue";

const message = {
  instagramAccountId: "ig_456",
  accountConnectionId: "acct_1",
  messageId: "mid:1",
  messageText: "請問課程多少錢？",
  senderId: "fan_1",
};

const metaAccount = { id: "acct_1", provider: "META", aiAssistant: { enabled: true } };

beforeEach(() => {
  vi.clearAllMocks();
  redis.lists.clear();
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
  mockPrisma.instagramAccount.findFirst.mockResolvedValue(metaAccount);
  mockPrisma.aiDraft.findUnique.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("maybeEnqueueAiDraft", () => {
  it("queues a debounced draft job with an id derived from the account and message", async () => {
    await expect(maybeEnqueueAiDraft(message, 1000)).resolves.toBe(true);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "ai-draft",
      expect.objectContaining({
        accountId: "acct_1",
        igsid: "fan_1",
        messageId: "mid:1",
        receivedAt: 1000,
      }),
      expect.objectContaining({
        jobId: aiDraftJobId("acct_1", "mid:1"),
        delay: 15_000,
        attempts: 3,
      })
    );
    // BullMQ rejects ":" in custom ids.
    expect(aiDraftJobId("acct_1", "mid:1")).not.toContain(":");
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { instagramId: "ig_456", id: "acct_1" } })
    );
  });

  it("does nothing without ANTHROPIC_API_KEY on the worker, before touching the database", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    await expect(maybeEnqueueAiDraft(message, 1000)).resolves.toBe(false);
    expect(mockPrisma.instagramAccount.findFirst).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("does nothing when the assistant is off or was never set up", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValueOnce({
      ...metaAccount,
      aiAssistant: { enabled: false },
    });
    await expect(maybeEnqueueAiDraft(message, 1000)).resolves.toBe(false);

    mockPrisma.instagramAccount.findFirst.mockResolvedValueOnce({ ...metaAccount, aiAssistant: null });
    await expect(maybeEnqueueAiDraft(message, 1000)).resolves.toBe(false);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("skips Zernio-connected accounts", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({ ...metaAccount, provider: "ZERNIO" });

    await expect(maybeEnqueueAiDraft(message, 1000)).resolves.toBe(false);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("skips quick-reply taps and messages without text", async () => {
    await expect(maybeEnqueueAiDraft({ ...message, fromQuickReply: true }, 1000)).resolves.toBe(false);
    await expect(maybeEnqueueAiDraft({ ...message, messageText: "   " }, 1000)).resolves.toBe(false);
    expect(mockPrisma.instagramAccount.findFirst).not.toHaveBeenCalled();
  });

  it("records each message of a burst once, with emails masked", async () => {
    await maybeEnqueueAiDraft(message, 1000);
    await maybeEnqueueAiDraft(message, 1000); // Meta redelivery
    await maybeEnqueueAiDraft({ ...message, messageId: "mid:2", messageText: "我的信箱 a@b.com" }, 2000);

    const burst = await readBurst("acct_1", "fan_1");
    expect(burst.map((entry) => entry.id)).toEqual(["mid:1", "mid:2"]);
    expect(burst[1].text).toBe("(message with an email)");
    expect(JSON.stringify([...redis.lists.values()])).not.toContain("a@b.com");
    // The job is added again, but BullMQ dedupes on the identical job id.
    expect(mockQueueAdd.mock.calls[0][2].jobId).toBe(mockQueueAdd.mock.calls[1][2].jobId);
  });

  it("ignores a redelivery of a message that already has a draft", async () => {
    mockPrisma.aiDraft.findUnique.mockResolvedValue({ id: "draft_1" });

    await expect(maybeEnqueueAiDraft(message, 1000)).resolves.toBe(false);
    expect(await readBurst("acct_1", "fan_1")).toEqual([]);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("clears the burst only through the message a draft answered", async () => {
    for (const id of ["m1", "m2", "m3"]) {
      await maybeEnqueueAiDraft({ ...message, messageId: id }, 1000);
    }
    const burst = await readBurst("acct_1", "fan_1");
    await clearBurstThrough("acct_1", "fan_1", burst, "m2");
    expect((await readBurst("acct_1", "fan_1")).map((entry) => entry.id)).toEqual(["m3"]);
  });
});
