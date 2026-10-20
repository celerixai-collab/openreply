/**
 * Comment reconciliation — ad copies of a boosted post.
 *
 * Comments left on an ad carry the ad's own media id, so the sweep has to look
 * at those media too or a webhook Meta never delivers is lost for good.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, queueAdd, readComments } = vi.hoisted(() => ({
  mockPrisma: {
    $queryRaw: vi.fn(),
    automation: { findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  queueAdd: vi.fn(),
  readComments: vi.fn(),
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: queueAdd }),
}));
vi.mock("@/lib/instagram/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instagram/provider")>()),
  createInstagramContext: async () => ({
    provider: "META",
    accessToken: "local-test",
  }),
  getRecentMediaComments: readComments,
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  adMediaFor,
  reconcileComments,
} from "../lib/polling/comment-reconciler";

const POST = "18023946917554990";
const AD = "17899788633163100";

describe("adMediaFor", () => {
  beforeEach(() => {
    mockPrisma.$queryRaw.mockReset();
  });

  it("returns the ad media ids seen for the post", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ mediaId: AD }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("never returns the post itself, so it is not swept twice", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { mediaId: AD },
      { mediaId: POST },
    ]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("drops rows without a media id", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { mediaId: null },
      { mediaId: AD },
    ]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("returns nothing when the post was never boosted", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });

  it("swallows a query failure, leaving the post itself still swept", async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error("connection lost"));
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });
});

describe("comment polling does not recreate unsafe sends", () => {
  beforeEach(() => {
    queueAdd.mockReset();
    mockPrisma.operationalEvent.create.mockResolvedValue({});
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        id: "campaign",
        name: "Campaign",
        workspaceId: "workspace",
        postId: POST,
        matchAnyWord: false,
        keywords: ["AI"],
        publicReplyEnabled: true,
        instagramAccount: {
          id: "connection",
          instagramId: "owner",
          provider: "META",
          accessToken: "test",
        },
      },
    ]);
    readComments.mockResolvedValue([
      {
        id: "old",
        text: "AI",
        from: { id: "reader" },
        timestamp: new Date().toISOString(),
      },
      {
        id: "new",
        text: "AI",
        from: { id: "another-reader" },
        timestamp: new Date().toISOString(),
      },
    ]);
  });
  it.each([
    { status: "FAILED", attempts: 1, dmDeliveryUnconfirmed: true },
    { status: "FAILED", attempts: 3, dmDeliveryUnconfirmed: false },
    {
      status: "FAILED",
      attempts: 1,
      errorMessage: "MetaApiError 1: An unknown error has occurred.",
    },
    { status: "PENDING", attempts: 1, dmDeliveryUnconfirmed: true },
  ])(
    "leaves an unsafe old comment alone while continuing new comments: %j",
    async (state) => {
      mockPrisma.dmLog.findMany.mockResolvedValue([
        { commentId: "old", publicReplySentAt: new Date(), ...state },
      ]);
      await reconcileComments();
      await reconcileComments();
      expect(queueAdd).toHaveBeenCalledTimes(2);
      for (const [, data] of queueAdd.mock.calls)
        expect(data.commentId).toBe("new");
    },
  );

  it("still DMs comments the account replied to, by hand or by a public reply", async () => {
    readComments.mockResolvedValue([
      {
        id: "replied-by-campaign",
        text: "AI",
        from: { id: "reader" },
        timestamp: new Date().toISOString(),
        replies: { data: [{ from: { id: "owner" } }] },
      },
      {
        id: "replied-by-hand",
        text: "AI",
        from: { id: "another-reader" },
        timestamp: new Date().toISOString(),
        replies: { data: [{ from: { id: "owner" } }] },
      },
    ]);
    mockPrisma.dmLog.findMany.mockResolvedValue([
      {
        commentId: "replied-by-campaign",
        status: "PENDING",
        attempts: 0,
        dmDeliveryUnconfirmed: false,
        errorMessage: "Re-queued after Instagram throttling on 2026-10-20",
        updatedAt: new Date(),
        publicReplySentAt: new Date(),
      },
    ]);
    await reconcileComments();
    expect(queueAdd.mock.calls.map(([, data]) => data.commentId).sort()).toEqual([
      "replied-by-campaign",
      "replied-by-hand",
    ]);
  });

  it("does not queue a comment whose retry is already scheduled", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([
      {
        commentId: "old",
        status: "PENDING",
        attempts: 0,
        dmDeliveryUnconfirmed: false,
        errorMessage: "Retry scheduled: paced to protect the account",
        updatedAt: new Date(),
        publicReplySentAt: new Date(),
      },
    ]);
    await reconcileComments();
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd.mock.calls[0][1].commentId).toBe("new");
  });

  it("does not sweep a comment skipped because the person already got the DM", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([
      { commentId: "old", status: "SKIPPED_DEDUP", attempts: 0, dmDeliveryUnconfirmed: false, updatedAt: new Date(), publicReplySentAt: null },
    ]);
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        id: "campaign",
        name: "Campaign",
        workspaceId: "workspace",
        postId: POST,
        matchAnyWord: false,
        keywords: ["AI"],
        publicReplyEnabled: false,
        instagramAccount: { id: "connection", instagramId: "owner", provider: "META", accessToken: "test" },
      },
    ]);
    await reconcileComments();
    expect(queueAdd.mock.calls.map(([, data]) => data.commentId)).toEqual(["new"]);
  });
});
