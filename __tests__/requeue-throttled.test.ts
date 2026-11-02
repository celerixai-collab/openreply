import { beforeEach, describe, expect, it, vi } from "vitest";

const getDelayed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queue/client", () => ({ getDMQueue: () => ({ getDelayed }) }));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/contacts/contacts", () => ({ claimOnce: vi.fn(async () => true) }));

import { removeDuplicateDelayedComments } from "@/lib/queue/requeue-throttled";

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
