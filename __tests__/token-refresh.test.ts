import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, refreshMock } = vi.hoisted(() => ({
  prismaMock: {
    instagramAccount: { findMany: vi.fn(), update: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  refreshMock: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: prismaMock }));
vi.mock("@/lib/meta/client", () => ({ refreshLongLivedToken: refreshMock }));
vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: (token: string) => `plain:${token}`,
  encryptToken: (token: string) => `enc:${token}`,
}));

import { refreshExpiringTokens } from "@/lib/instagram/token-refresh";
import { failedOnExpiredToken } from "@/lib/queue/comment-delivery";

const account = { id: "a1", workspaceId: "w1", username: "leo", accessToken: "old" };

describe("refreshExpiringTokens", () => {
  beforeEach(() => vi.clearAllMocks());

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

describe("failedOnExpiredToken", () => {
  it("recognises Instagram's expired-session error only", () => {
    expect(failedOnExpiredToken("Error validating access token: Session has expired on Friday")).toBe(true);
    expect(failedOnExpiredToken("Instagram throttled: thread does not exist")).toBe(false);
    expect(failedOnExpiredToken(null)).toBe(false);
  });
});
