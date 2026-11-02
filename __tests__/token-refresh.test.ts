import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, refreshMock, redisMock } = vi.hoisted(() => ({
  redisMock: { get: vi.fn(), set: vi.fn() },
  prismaMock: {
    instagramAccount: { findMany: vi.fn(), update: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  refreshMock: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: prismaMock }));
vi.mock("@/lib/meta/client", () => ({ refreshLongLivedToken: refreshMock }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => redisMock }));
vi.mock("@/lib/queue/token-pause", async (original) => ({
  ...(await original<typeof import("@/lib/queue/token-pause")>()),
  clearTokenInvalid: vi.fn(),
}));
vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: (token: string) => `plain:${token}`,
  encryptToken: (token: string) => `enc:${token}`,
}));

import { refreshExpiringTokens } from "@/lib/instagram/token-refresh";

const account = { id: "a1", workspaceId: "w1", username: "leo", accessToken: "old" };

describe("refreshExpiringTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.get.mockResolvedValue("2026-11-03");
  });

  function daysLeftAsked() {
    const cutoff = prismaMock.instagramAccount.findMany.mock.calls[0][0].where.tokenExpiresAt.lte;
    return (cutoff.getTime() - Date.now()) / 864e5;
  }

  it("renews once a month after a renewal has worked", async () => {
    prismaMock.instagramAccount.findMany.mockResolvedValue([]);
    await refreshExpiringTokens();
    expect(daysLeftAsked()).toBeCloseTo(30, 1);
  });

  it("tries as soon as Instagram allows until one renewal has worked, then remembers it", async () => {
    redisMock.get.mockResolvedValue(null);
    prismaMock.instagramAccount.findMany.mockResolvedValue([account]);
    refreshMock.mockResolvedValue({ accessToken: "new", expiresIn: 5184000 });

    await refreshExpiringTokens();

    expect(daysLeftAsked()).toBeCloseTo(58.5, 1);
    expect(redisMock.set).toHaveBeenCalledWith("ops:token-renewal-proven", expect.any(String));
  });

  it("does not count a failed renewal as proof", async () => {
    redisMock.get.mockResolvedValue(null);
    prismaMock.instagramAccount.findMany.mockResolvedValue([account]);
    refreshMock.mockRejectedValue(new Error("nope"));

    await refreshExpiringTokens();

    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("stores the renewed token and its new expiry", async () => {
    prismaMock.instagramAccount.findMany.mockResolvedValue([account]);
    refreshMock.mockResolvedValue({ accessToken: "new", expiresIn: 5184000 });

    const results = await refreshExpiringTokens();

    expect(refreshMock).toHaveBeenCalledWith("plain:old");
    const { data } = prismaMock.instagramAccount.update.mock.calls[0][0];
    expect(data.accessToken).toBe("enc:new");
    expect(data.tokenExpiresAt.getTime()).toBeGreaterThan(Date.now() + 59 * 864e5);
    expect(results).toEqual([{ instagramAccountId: "a1", username: "leo", status: "refreshed" }]);
  });

  it("records a failure and keeps going", async () => {
    prismaMock.instagramAccount.findMany.mockResolvedValue([account, { ...account, id: "a2" }]);
    refreshMock.mockRejectedValueOnce(new Error("nope")).mockResolvedValueOnce({ accessToken: "new", expiresIn: 1 });

    const results = await refreshExpiringTokens();

    expect(prismaMock.operationalEvent.create.mock.calls[0][0].data.source).toBe("TOKEN_REFRESH");
    expect(results.map((r) => r.status)).toEqual(["failed", "refreshed"]);
  });
});
