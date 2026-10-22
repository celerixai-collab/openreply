import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockAdd, mockClaim } = vi.hoisted(() => ({
  mockPrisma: { automation: { findMany: vi.fn() }, dmLog: { findMany: vi.fn() } },
  mockAdd: vi.fn(),
  mockClaim: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/contacts/contacts", () => ({ claimOnce: mockClaim }));
vi.mock("@/lib/queue/client", () => ({
  FOLLOWUP_JOB_NAME: "process-followup",
  getDMQueue: () => ({ add: mockAdd }),
}));

import { backfillFollowUps } from "@/lib/queue/backfill-followups";

const now = new Date("2026-10-23T02:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mockClaim.mockResolvedValue(true);
  mockPrisma.automation.findMany.mockResolvedValue([
    { id: "auto_a", instagramAccountId: "acct_1", instagramAccount: { instagramId: "ig_1" } },
  ]);
  mockPrisma.dmLog.findMany.mockResolvedValue([
    { automationId: "auto_a", commenterId: "u1", commenterName: "amy" },
    { automationId: "auto_a", commenterId: "u2", commenterName: null },
  ]);
  mockAdd.mockResolvedValue({});
});

describe("early-bird follow-up backfill", () => {
  it("queues one spaced follow-up per person who got the link before it was turned on", async () => {
    expect(await backfillFollowUps(now)).toBe(2);
    const where = mockPrisma.dmLog.findMany.mock.calls[0][0].where;
    expect(where.commentId).toEqual({ startsWith: "reveal:" });
    expect(where.dmSentAt.lt).toEqual(new Date("2026-10-22T16:50:00Z"));
    expect(where.dmSentAt.gt).toEqual(new Date(now.getTime() - 21 * 3600_000));
    expect(mockAdd).toHaveBeenNthCalledWith(
      1,
      "process-followup",
      { instagramAccountId: "ig_1", accountConnectionId: "acct_1", userId: "u1", automationId: "auto_a", commenterName: "amy" },
      { delay: 0, jobId: "followup_auto_a_u1" }
    );
    expect(mockAdd.mock.calls[1][2]).toEqual({ delay: 15_000, jobId: "followup_auto_a_u2" });
  });

  it("runs only once", async () => {
    mockClaim.mockResolvedValue(false);
    expect(await backfillFollowUps(now)).toBe(0);
    expect(mockAdd).not.toHaveBeenCalled();
  });
});
