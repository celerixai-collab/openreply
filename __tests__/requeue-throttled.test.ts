import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDelayed, getWaiting, getActive, add, prismaMock, restartPaceLine } = vi.hoisted(() => ({
  restartPaceLine: vi.fn(),
  add: vi.fn(),
  getDelayed: vi.fn(),
  getWaiting: vi.fn(),
  getActive: vi.fn(),
  prismaMock: { dmLog: { findMany: vi.fn(), updateMany: vi.fn() } },
}));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: () => ({ getDelayed, getWaiting, getActive, add }) }));
vi.mock("@/lib/db/client", () => ({ prisma: prismaMock }));
vi.mock("@/lib/utils/rate-limiter", () => ({ restartPaceLine }));
vi.mock("@/lib/contacts/contacts", () => ({ claimOnce: vi.fn(async () => true) }));

import { clearOrphanedRetryMarks, queueStrandedComments, removeDuplicateDelayedComments, respaceWaitingComments } from "@/lib/queue/requeue-throttled";

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

describe("respaceWaitingComments", () => {
  const NOW = 1_800_000_000_000;
  const waiting = (id: string, slot: number, extra: Record<string, unknown> = {}) => ({
    id,
    name: "process-comment",
    data: { commentId: id, instagramAccountId: "ig", paceSlotAt: slot, ...extra },
    updateData: vi.fn(async () => undefined),
    changeDelay: vi.fn(async () => undefined),
  });

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    getDelayed.mockReset();
    restartPaceLine.mockReset().mockResolvedValue([NOW + 10_000, NOW + 20_000]);
  });

  it("gives waiting comments new sending times at the current pace, oldest place first", async () => {
    const second = waiting("b", NOW + 7_000_000);
    const first = waiting("a", NOW + 3_000_000);
    getDelayed.mockResolvedValue([second, first]);

    await expect(respaceWaitingComments()).resolves.toBe(2);

    expect(restartPaceLine).toHaveBeenCalledWith("ig", 2);
    expect(first.updateData).toHaveBeenCalledWith(expect.objectContaining({ commentId: "a", paceSlotAt: NOW + 10_000 }));
    expect(first.changeDelay).toHaveBeenCalledWith(10_000);
    expect(second.updateData).toHaveBeenCalledWith(expect.objectContaining({ commentId: "b", paceSlotAt: NOW + 20_000 }));
    expect(second.changeDelay).toHaveBeenCalledWith(20_000);
  });

  it("leaves new comments, reply retries and jobs without a place alone", async () => {
    const live = waiting("live", NOW + 1000, { liveLine: true });
    const reply = waiting("reply_pub", NOW + 1000);
    const retry = waiting("retry", NOW + 1000, { paceSlotAt: undefined });
    getDelayed.mockResolvedValue([live, reply, retry]);

    await expect(respaceWaitingComments()).resolves.toBe(0);

    expect(restartPaceLine).not.toHaveBeenCalled();
    expect(live.changeDelay).not.toHaveBeenCalled();
    expect(reply.changeDelay).not.toHaveBeenCalled();
    expect(retry.changeDelay).not.toHaveBeenCalled();
  });

  it("carries on when a job started running in the meantime", async () => {
    const started = waiting("a", NOW + 1000);
    started.changeDelay.mockRejectedValue(new Error("not delayed"));
    const next = waiting("b", NOW + 2000);
    getDelayed.mockResolvedValue([started, next]);

    await expect(respaceWaitingComments()).resolves.toBe(1);
    expect(next.changeDelay).toHaveBeenCalledTimes(1);
  });
});

describe("queueStrandedComments", () => {
  const row = (commentId: string, automation: Record<string, unknown> = { postId: "post1" }) => ({
    id: `row-${commentId}`,
    commentId,
    commentText: "hi",
    commenterId: "person",
    commenterName: null,
    automation,
    instagramAccount: { id: "conn", instagramId: "ig" },
  });

  beforeEach(() => {
    getDelayed.mockReset().mockResolvedValue([]);
    getWaiting.mockReset().mockResolvedValue([]);
    getActive.mockReset().mockResolvedValue([]);
    add.mockReset().mockResolvedValue(undefined);
    prismaMock.dmLog.findMany.mockReset();
  });

  it("queues a waiting comment that has no job, from its own row", async () => {
    prismaMock.dmLog.findMany.mockResolvedValue([row("a")]);

    await expect(queueStrandedComments()).resolves.toBe(1);

    expect(add).toHaveBeenCalledWith("process-comment", {
      instagramAccountId: "ig",
      accountConnectionId: "conn",
      commentId: "a",
      commentText: "hi",
      commenterId: "person",
      commenterName: undefined,
      mediaId: "post1",
      source: "POLLING",
    });
  });

  it("leaves comments that have a DM job, and queues a comment once however many campaigns it matched", async () => {
    getDelayed.mockResolvedValue([job("comment_a_pace_1", "a", 1000), job("comment_b_pub", "b", 1000)]);
    prismaMock.dmLog.findMany.mockResolvedValue([row("a"), row("b"), row("b")]);

    await expect(queueStrandedComments()).resolves.toBe(1);

    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][1]).toMatchObject({ commentId: "b" });
  });

  it("only looks at comments Instagram can still take, past the time a new one needs to get going", async () => {
    prismaMock.dmLog.findMany.mockResolvedValue([]);
    await queueStrandedComments();
    const where = prismaMock.dmLog.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      status: "PENDING",
      attempts: { lt: 3 },
      NOT: { commentId: { startsWith: "reveal:" } },
      automation: { isActive: true },
    });
    expect(where.updatedAt.lt.getTime()).toBeLessThan(Date.now() - 29 * 60_000);
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
