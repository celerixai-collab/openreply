/**
 * Rate Limiter — Unit Tests
 *
 * Tests the hourly private-reply cap enforcement using mocked Redis.
 * Assertions derive from RATE_LIMIT_MAX so they survive a change to the cap.
 */

import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

const { mockGet, mockEval, mockDel, mockDecr, mockPttl, mockSet } = vi.hoisted(() => ({
  mockSet: vi.fn(),
  mockGet: vi.fn(),
  mockEval: vi.fn(),
  mockDel: vi.fn(),
  mockDecr: vi.fn(),
  mockPttl: vi.fn(),
}));

vi.mock("ioredis", () => {
  const MockRedis = vi.fn().mockImplementation(function (
    this: Record<string, unknown>
  ) {
    this.get = mockGet;
    this.eval = mockEval;
    this.del = mockDel;
    this.decr = mockDecr;
    this.pttl = mockPttl;
    this.set = mockSet;
    return this;
  });
  return { default: MockRedis };
});

vi.stubEnv("REDIS_URL", "redis://localhost:6379");

import {
  checkRateLimit,
  incrementDMCounter,
  reserveDMSlot,
  releaseDMSlot,
  reservePaceSlot,
  restartPaceLine,
  RATE_LIMIT_MAX,
} from "../lib/utils/rate-limiter";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkRateLimit", () => {
  it("should allow when count is below limit", async () => {
    mockGet.mockResolvedValue("50");

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(50);
    expect(result.remainingDMs).toBe(RATE_LIMIT_MAX - 50);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(false);
    expect(result.reserved).toBe(false);
  });

  it("should allow when no previous count exists", async () => {
    mockGet.mockResolvedValue(null);

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(0);
    expect(result.remainingDMs).toBe(RATE_LIMIT_MAX);
  });

  it("should deny when count reaches the limit", async () => {
    mockGet.mockResolvedValue(String(RATE_LIMIT_MAX));

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(true);
    expect(result.shouldSkip).toBe(false);
  });

  it("should skip after max requeue attempts", async () => {
    mockGet.mockResolvedValue(String(RATE_LIMIT_MAX));

    const result = await checkRateLimit("account_123", 3);

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(true);
  });
});

describe("reserveDMSlot", () => {
  it("should atomically reserve a slot when below the hourly cap", async () => {
    mockEval.mockResolvedValue([1, 51, 139]);

    const result = await reserveDMSlot("account_123");

    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "rate:dm:account_123",
      RATE_LIMIT_MAX,
      3600
    );
    expect(result.allowed).toBe(true);
    expect(result.reserved).toBe(true);
    expect(result.currentCount).toBe(51);
    expect(result.remainingDMs).toBe(139);
  });

  it("should recommend requeue when the atomic reserve is denied", async () => {
    mockEval.mockResolvedValue([0, RATE_LIMIT_MAX, 0]);

    const result = await reserveDMSlot("account_123", 0);

    expect(result.allowed).toBe(false);
    expect(result.reserved).toBe(false);
    expect(result.shouldRequeue).toBe(true);
    expect(result.shouldSkip).toBe(false);
  });

  it("should skip after max requeue attempts", async () => {
    mockEval.mockResolvedValue(["0", String(RATE_LIMIT_MAX), "0"]);

    const result = await reserveDMSlot("account_123", 3);

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(true);
  });
});

describe("incrementDMCounter", () => {
  it("should use the atomic reservation path", async () => {
    mockEval.mockResolvedValue([1, 51, 139]);

    const count = await incrementDMCounter("account_123");

    expect(mockEval).toHaveBeenCalled();
    expect(count).toBe(51);
  });
});

describe("releaseDMSlot", () => {
  it("hands a reserved slot back and returns the new count", async () => {
    mockDecr.mockResolvedValue(49);

    const count = await releaseDMSlot("account_123");

    expect(mockDecr).toHaveBeenCalledWith("rate:dm:account_123");
    expect(count).toBe(49);
  });

  it("clamps to zero and clears the key when nothing was reserved", async () => {
    mockDecr.mockResolvedValue(-1);

    const count = await releaseDMSlot("account_123");

    expect(count).toBe(0);
    expect(mockDel).toHaveBeenCalledWith("rate:dm:account_123");
  });
});

describe("reservePaceSlot", () => {
  const NOW = 1_800_000_000_000;
  let hourlyBudgetLeft: boolean;
  const slotIs = (at: number) =>
    mockEval.mockImplementation(async (script: string) =>
      script.includes("ZCARD") ? (hourlyBudgetLeft ? 1 : 0) : String(at)
    );
  const budgetCalls = () =>
    mockEval.mock.calls.filter(([script]) => (script as string).includes("ZCARD"));
  const slotCalls = () =>
    mockEval.mock.calls.filter(([script]) => !(script as string).includes("ZCARD"));

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    hourlyBudgetLeft = true;
    mockPttl.mockReset().mockResolvedValue(-2);
    mockSet.mockReset().mockResolvedValue("OK");
    mockEval.mockReset();
    slotIs(NOW);
  });
  afterEach(() => vi.restoreAllMocks());

  it("sends right away when nobody is ahead", async () => {
    await expect(reservePaceSlot("ig")).resolves.toEqual({ allowed: true });
  });

  it("gives a later comment its own place in line, ten seconds apart at six a minute", async () => {
    slotIs(NOW + 30_000);
    await expect(reservePaceSlot("ig")).resolves.toEqual({
      allowed: false,
      retryInMs: 30_000,
      slotAt: NOW + 30_000,
    });
    expect(mockEval).toHaveBeenCalledWith(expect.any(String), 1, "pace:next:ig", NOW, 10_000);
  });

  it("lets a job through on the place it already waited for, without taking another", async () => {
    await expect(reservePaceSlot("ig", NOW - 500)).resolves.toEqual({ allowed: true });
    expect(slotCalls()).toHaveLength(0);
  });

  it("sends a job holding an old, closer-spaced place to the back when the last send was too recent", async () => {
    mockSet.mockResolvedValue(null);
    slotIs(NOW + 40_000);
    await expect(reservePaceSlot("ig", NOW - 500)).resolves.toEqual({
      allowed: false,
      retryInMs: 40_000,
      slotAt: NOW + 40_000,
    });
  });

  it("takes a new place when the job woke long after its slot, so a stopped worker does not cause a burst", async () => {
    slotIs(NOW + 10_000);
    await expect(reservePaceSlot("ig", NOW - 5 * 60_000)).resolves.toMatchObject({ allowed: false });
    expect(slotCalls()).toHaveLength(1);
  });

  it("holds everyone, also a job on its slot, until the cooldown ends", async () => {
    mockPttl.mockResolvedValue(60_000);
    slotIs(NOW + 60_000);
    await expect(reservePaceSlot("ig", NOW - 500)).resolves.toEqual({
      allowed: false,
      retryInMs: 60_000,
      slotAt: NOW + 60_000,
    });
    expect(mockEval).toHaveBeenCalledWith(expect.any(String), 1, "pace:next:ig", NOW + 60_000, 10_000);
  });

  describe("comments that just arrived", () => {
    it("have their own line, so a backlog does not delay them", async () => {
      await expect(reservePaceSlot("ig", undefined, true)).resolves.toEqual({ allowed: true });
      expect(mockEval).toHaveBeenCalledWith(expect.any(String), 1, "pace:live:ig", NOW, 10_000);
      expect(mockEval).not.toHaveBeenCalledWith(expect.any(String), 1, "pace:next:ig", NOW, 10_000);
    });

    it("wait their turn in that line during a burst", async () => {
      slotIs(NOW + 20_000);
      await expect(reservePaceSlot("ig", undefined, true)).resolves.toEqual({
        allowed: false,
        retryInMs: 20_000,
        slotAt: NOW + 20_000,
      });
    });

    it("are not held back by the gap that spaces out the backlog", async () => {
      mockSet.mockResolvedValue(null);
      await expect(reservePaceSlot("ig", NOW - 500, true)).resolves.toEqual({ allowed: true });
    });

    it("still wait for a cooldown to end", async () => {
      mockPttl.mockResolvedValue(60_000);
      slotIs(NOW + 60_000);
      await expect(reservePaceSlot("ig", NOW - 500, true)).resolves.toEqual({
        allowed: false,
        retryInMs: 60_000,
        slotAt: NOW + 60_000,
      });
    });
  });

  describe("the hourly budget", () => {
    it("keeps part of the hour for new comments: 180 for them, 150 for the backlog", async () => {
      await reservePaceSlot("ig", undefined, true);
      expect(budgetCalls()[0].slice(2, 6)).toEqual(["pace:sent:ig", NOW, 3_600_000, 180]);
      mockEval.mockClear();
      await reservePaceSlot("ig", NOW - 500);
      expect(budgetCalls()[0].slice(2, 6)).toEqual(["pace:sent:ig", NOW, 3_600_000, 150]);
    });

    it.each([
      ["a comment holding its place", NOW - 500, false],
      ["a new comment", undefined, true],
    ])("makes %s try again in a minute once it is used up", async (_name, held, live) => {
      hourlyBudgetLeft = false;
      await expect(reservePaceSlot("ig", held, live)).resolves.toEqual({
        allowed: false,
        retryInMs: 60_000,
        slotAt: NOW + 60_000,
      });
    });
  });
});

describe("restartPaceLine", () => {
  const NOW = 1_800_000_000_000;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    mockPttl.mockReset().mockResolvedValue(-2);
    mockSet.mockReset().mockResolvedValue("OK");
  });
  afterEach(() => vi.restoreAllMocks());

  it("hands out times one spacing apart and points the line past the last", async () => {
    await expect(restartPaceLine("ig", 3)).resolves.toEqual([NOW + 10_000, NOW + 20_000, NOW + 30_000]);
    expect(mockSet).toHaveBeenCalledWith("pace:next:ig", String(NOW + 40_000), "EX", 604800);
  });

  it("starts after a cooldown", async () => {
    mockPttl.mockResolvedValue(60_000);
    await expect(restartPaceLine("ig", 1)).resolves.toEqual([NOW + 70_000]);
  });
});
