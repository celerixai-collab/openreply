import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockQueue, mockIsAiPaused } = vi.hoisted(() => ({
  mockPrisma: {
    aiAssistant: { findUnique: vi.fn() },
    contact: { findFirst: vi.fn() },
    aiDraft: { findFirst: vi.fn() },
    dmLog: { findFirst: vi.fn() },
  },
  mockQueue: { add: vi.fn(), getJob: vi.fn() },
  mockIsAiPaused: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/ai/takeover", () => ({ isAiPaused: mockIsAiPaused }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => mockQueue,
  FOLLOWUP_JOB_NAME: "process-followup",
}));

import { followUpBlockedReason, scheduleFollowUp } from "../lib/queue/followup";

const campaign = {
  id: "auto_a",
  instagramAccountId: "acct_1",
  followUpEnabled: true,
  followUpMessage: "還有想問的嗎？🙌",
  followUpDelayMinutes: 60,
  instagramAccount: { instagramId: "ig_1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockQueue.getJob.mockResolvedValue(undefined);
  mockPrisma.aiAssistant.findUnique.mockResolvedValue(null);
  mockPrisma.aiDraft.findFirst.mockResolvedValue(null);
  mockIsAiPaused.mockResolvedValue(false);
});

describe("scheduleFollowUp", () => {
  it("schedules one follow-up per person per campaign after the delay", async () => {
    expect(await scheduleFollowUp(campaign, "fan_1", "fan")).toBe("scheduled");
    expect(mockQueue.add).toHaveBeenCalledWith(
      "process-followup",
      expect.objectContaining({ userId: "fan_1", automationId: "auto_a" }),
      { delay: 60 * 60_000, jobId: "followup_auto_a_fan_1" }
    );
  });

  it("pushes a waiting follow-up back when they message again", async () => {
    const job = { getState: vi.fn(async () => "delayed"), changeDelay: vi.fn() };
    mockQueue.getJob.mockResolvedValue(job);
    expect(await scheduleFollowUp(campaign, "fan_1", null)).toBe("rescheduled");
    expect(job.changeDelay).toHaveBeenCalledWith(60 * 60_000);
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it("never sends a second one once it went out", async () => {
    mockQueue.getJob.mockResolvedValue({ getState: vi.fn(async () => "completed") });
    expect(await scheduleFollowUp(campaign, "fan_1", null)).toBe("skipped");
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it("does nothing when the campaign has no follow-up", async () => {
    expect(await scheduleFollowUp({ ...campaign, followUpEnabled: false }, "fan_1", null)).toBe("skipped");
    expect(mockQueue.getJob).not.toHaveBeenCalled();
  });
});

describe("followUpBlockedReason", () => {
  it("sends only to the AI test usernames during a test run of that campaign", async () => {
    mockPrisma.aiAssistant.findUnique.mockResolvedValue({ testUsernames: ["im.ynyn"], campaignIds: ["auto_a"] });
    mockPrisma.contact.findFirst.mockResolvedValue({ username: "someone" });
    expect(await followUpBlockedReason("auto_a", "acct_1", "fan_1")).toBe("not on the AI test list");
    mockPrisma.contact.findFirst.mockResolvedValue({ username: "im.ynyn" });
    expect(await followUpBlockedReason("auto_a", "acct_1", "fan_1")).toBeNull();
  });

  it("skips a conversation the creator took over", async () => {
    mockIsAiPaused.mockResolvedValue(true);
    expect(await followUpBlockedReason("auto_a", "acct_1", "fan_1")).toMatch(/creator/);
  });

  it("skips people who already joined or said no", async () => {
    mockPrisma.aiDraft.findFirst.mockResolvedValue({ intent: "already_joined" });
    expect(await followUpBlockedReason("auto_a", "acct_1", "fan_1")).toMatch(/joined/);
    mockPrisma.aiDraft.findFirst.mockResolvedValue({ intent: "declined" });
    expect(await followUpBlockedReason("auto_a", "acct_1", "fan_1")).toMatch(/declined/);
  });
});
