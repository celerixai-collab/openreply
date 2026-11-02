import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDelayed, getWaiting, getActive, prismaMock } = vi.hoisted(() => ({
  getDelayed: vi.fn(),
  getWaiting: vi.fn(),
  getActive: vi.fn(),
  prismaMock: { dmLog: { findMany: vi.fn(), updateMany: vi.fn() } },
}));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: () => ({ getDelayed, getWaiting, getActive }) }));
vi.mock("@/lib/db/client", () => ({ prisma: prismaMock }));
vi.mock("@/lib/contacts/contacts", () => ({ claimOnce: vi.fn(async () => true) }));

import { clearOrphanedRetryMarks, removeDuplicateDelayedComments } from "@/lib/queue/requeue-throttled";

function job(id: string, commentId: string, wakesAt: number, name = "process-comment") {
  return {
    id,
    name,
    data: { commentId },
    timestamp: wakesAt,
    delay: 0,
    remove: vi.fn(async () => undefined),
  };
}

describe("removeDuplicateDelayedComments", () => {
  beforeEach(() => getDelayed.mockReset());

  it("keeps the copy of each comment that wakes first, and its public-reply retry", async () => {
    const later = job("comment_a_pace_2", "a", 2000);
    const first = job("comment_a_pace_1", "a", 1000);
    const publicRetry = job("comment_a_pub", "a", 3000);
    const other = job("comment_b_pace_1", "b", 5000);
    getDelayed.mockResolvedValue([later, first, publicRetry, other]);

    await expect(removeDuplicateDelayedComments()).resolves.toBe(1);

    expect(later.remove).toHaveBeenCalledTimes(1);
    expect(first.remove).not.toHaveBeenCalled();
    expect(publicRetry.remove).not.toHaveBeenCalled();
    expect(other.remove).not.toHaveBeenCalled();
  });

  it("leaves other kinds of waiting job alone", async () => {
    const followUp = { ...job("followup_1", "x", 1000, "process-followup"), data: {} };
    getDelayed.mockResolvedValue([followUp]);

    await expect(removeDuplicateDelayedComments()).resolves.toBe(0);
    expect(followUp.remove).not.toHaveBeenCalled();
  });
});

describe("clearOrphanedRetryMarks", () => {
  beforeEach(() => {
    getDelayed.mockReset().mockResolvedValue([]);
    getWaiting.mockReset().mockResolvedValue([]);
    getActive.mockReset().mockResolvedValue([]);
    prismaMock.dmLog.findMany.mockReset();
    prismaMock.dmLog.updateMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it("hands a comment back to the sweep when no job is left for its DM", async () => {
    getDelayed.mockResolvedValue([job("comment_a_pace_1", "a", 1000), job("comment_b_pub", "b", 1000)]);
    getActive.mockResolvedValue([job("comment_c", "c", 1000)]);
    prismaMock.dmLog.findMany.mockResolvedValue([
      { id: "row-a", commentId: "a" },
      { id: "row-b", commentId: "b" },
      { id: "row-c", commentId: "c" },
    ]);

    await expect(clearOrphanedRetryMarks()).resolves.toBe(1);

    expect(prismaMock.dmLog.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["row-b"] } },
      data: { errorMessage: null },
    });
  });

  it("does nothing when every marked comment has its job", async () => {
    getWaiting.mockResolvedValue([job("comment_a_pace_1", "a", 1000)]);
    prismaMock.dmLog.findMany.mockResolvedValue([{ id: "row-a", commentId: "a" }]);

    await expect(clearOrphanedRetryMarks()).resolves.toBe(0);
    expect(prismaMock.dmLog.updateMany).not.toHaveBeenCalled();
  });
});
