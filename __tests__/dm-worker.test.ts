import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockPrisma,
  mockSendPrivateReply,
  mockSendPrivateReplyWithLinkButton,
  mockSendPrivateReplyWithButton,
  mockGetUserFollowStatus,
  mockGetUserProfile,
  mockSendDirectMessageWithButton,
  mockSendDirectMessage,
  mockSendDirectMessageWithLinkButton,
  mockSendDirectMessageWithEmailQuickReply,
  mockDecryptToken,
  mockMatchKeywords,
  mockReserveDMSlot,
  mockReleaseDMSlot,
  mockQueueAdd,
  mockReserveWorkspaceDMSend,
  mockReleaseWorkspaceDMReservation,
} = vi.hoisted(() => ({
  mockPrisma: {
    zernioConnection: { findUnique: vi.fn() },
    postbackDelivery: { create: vi.fn(), delete: vi.fn(), findUnique: vi.fn() },
    automation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    dmLog: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    instagramAccount: {
      findUnique: vi.fn(),
    },
    operationalEvent: {
      create: vi.fn(),
    },
    contact: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  mockSendPrivateReply: vi.fn(),
  mockSendPrivateReplyWithLinkButton: vi.fn(),
  mockSendPrivateReplyWithButton: vi.fn(),
  mockGetUserFollowStatus: vi.fn(),
  mockGetUserProfile: vi.fn(),
  mockSendDirectMessageWithButton: vi.fn(),
  mockSendDirectMessage: vi.fn(),
  mockSendDirectMessageWithLinkButton: vi.fn(),
  mockSendDirectMessageWithEmailQuickReply: vi.fn(),
  mockDecryptToken: vi.fn(),
  mockMatchKeywords: vi.fn(),
  mockReserveDMSlot: vi.fn(),
  mockReleaseDMSlot: vi.fn(),
  mockQueueAdd: vi.fn(),
  mockReserveWorkspaceDMSend: vi.fn(),
  mockReleaseWorkspaceDMReservation: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

// The AI assistant's hook: processMessage hands it messages nothing else
// answered. Its own conditions are covered in ai-trigger.test.ts.
const { mockMaybeEnqueueAiDraft } = vi.hoisted(() => ({
  mockMaybeEnqueueAiDraft: vi.fn(),
}));
vi.mock("@/lib/ai/trigger", () => ({
  maybeEnqueueAiDraft: mockMaybeEnqueueAiDraft,
}));

vi.mock("@/lib/meta/client", () => ({
  sendPrivateReply: mockSendPrivateReply,
  sendPrivateReplyWithLinkButton: mockSendPrivateReplyWithLinkButton,
  sendPrivateReplyWithButton: mockSendPrivateReplyWithButton,
  getUserFollowStatus: mockGetUserFollowStatus,
  getUserProfile: mockGetUserProfile,
  sendDirectMessageWithButton: mockSendDirectMessageWithButton,
  sendDirectMessage: mockSendDirectMessage,
  sendDirectMessageWithLinkButton: mockSendDirectMessageWithLinkButton,
  sendDirectMessageWithEmailQuickReply: mockSendDirectMessageWithEmailQuickReply,
  sendCommentReply: vi.fn(),
  MetaApiError: class MetaApiError extends Error {
    code: number;
    constructor(
      code: number,
      _subcode: number | undefined,
      _fbTraceId: string | undefined,
      message: string
    ) {
      super(message);
      this.code = code;
      this.name = "MetaApiError";
    }
  },
  TokenExpiredError: class TokenExpiredError extends Error {
    name = "TokenExpiredError";
  },
  RateLimitError: class RateLimitError extends Error {
    name = "RateLimitError";
  },
}));

vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: mockDecryptToken,
}));

vi.mock("@/lib/utils/keyword-matcher", () => ({
  matchKeywords: mockMatchKeywords,
}));

vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: mockReserveDMSlot,
  releaseDMSlot: mockReleaseDMSlot,
}));

vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mockReserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mockReleaseWorkspaceDMReservation,
}));

vi.mock("@/lib/ops/worker-health", () => ({
  recordWorkerAlert: vi.fn(),
}));

vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({
    add: mockQueueAdd,
  }),
  getRedisConnection: vi.fn(),
  POSTBACK_JOB_NAME: "process-postback",
  FOLLOWUP_JOB_NAME: "process-followup",
  MESSAGE_JOB_NAME: "process-message",
}));

vi.mock("bullmq", () => {
  function MockWorker(_name: string, processor: unknown) {
    (global as Record<string, unknown>).__dmWorkerProcessor = processor;
    return {
      on: vi.fn(),
      close: vi.fn(),
    };
  }
  return {
    Worker: MockWorker,
    UnrecoverableError: class UnrecoverableError extends Error {
      name = "UnrecoverableError";
    },
  };
});

import { MetaApiError, RateLimitError } from "@/lib/meta/client";
import { createDMWorker } from "../lib/queue/dm-worker";
import { getRedisConnection } from "@/lib/queue/client";
import { hashRecipientId } from "@/lib/tracking/server";
import {
  DEFAULT_EMAIL_INVALID_MESSAGE,
  DEFAULT_EMAIL_OPT_OUT_MESSAGE,
  DEFAULT_EMAIL_PROMPT_MESSAGE,
  defaultEmailPrompt,
} from "@/lib/contacts/email-copy";
import { isEmailOptOutMessage } from "@/lib/contacts/email-gate";

const usagePeriodStart = new Date("2026-05-01T00:00:00.000Z");

const mockAutomation = {
  id: "auto_789",
  workspaceId: "workspace_123",
  instagramAccountId: "ig_account_row_1",
  postId: "media_101",
  keywords: ["LINK", "PRICE"],
  dmMessage: "Hey {username}! Here is the link: https://example.com",
  isActive: true,
  wholeWordMatch: true,
  matchAnyPost: false,
  matchAnyWord: false,
  openingDmEnabled: false,
  openingDmMessage: null,
  openingDmButtonLabel: null,
  linkButtonLabel: null,
  publicReplyEnabled: false,
  publicReplyMessage: null,
  publicReplyMessages: [],
  instagramAccount: {
    id: "ig_account_row_1",
    instagramId: "ig_456",
    accessToken: "encrypted_token_abc",
  },
  workspace: {
    id: "workspace_123",
  },
  trackedLinks: [],
};

const mockJobData = {
  instagramAccountId: "ig_456",
  commentId: "comment_555",
  commentText: "I want the LINK!",
  commenterId: "commenter_999",
  commenterName: "commenter_user",
  mediaId: "media_101",
};

function getProcessor(): (job: {
  name?: string;
  data: typeof mockJobData | Record<string, unknown>;
  id: string;
  attemptsMade: number;
}) => Promise<void> {
  createDMWorker();
  return (global as Record<string, unknown>).__dmWorkerProcessor as (job: {
    name?: string;
    data: typeof mockJobData | Record<string, unknown>;
    id: string;
    attemptsMade: number;
  }) => Promise<void>;
}

function createMockJob(data: Record<string, unknown> = mockJobData) {
  return {
    data,
    id: "job_001",
    attemptsMade: 0,
  };
}

function createMockPostbackJob(
  data: Record<string, unknown> = {
    instagramAccountId: "ig_456",
    userId: "commenter_999",
    payload: "reveal:auto_789",
  }
) {
  return {
    name: "process-postback",
    data,
    id: "postback_job_001",
    attemptsMade: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.postbackDelivery.create.mockReset().mockResolvedValue({});
  mockPrisma.postbackDelivery.delete.mockReset().mockResolvedValue({});
  mockPrisma.postbackDelivery.findUnique.mockReset().mockResolvedValue(null);
  // No contacts by default: nobody has an email or an open email gate, so
  // every campaign without collectEmail runs exactly as it always has.
  mockPrisma.contact.findFirst.mockReset().mockResolvedValue(null);
  mockPrisma.contact.findUnique.mockReset().mockResolvedValue(null);
  mockPrisma.contact.upsert.mockReset().mockResolvedValue({});
  mockPrisma.contact.updateMany.mockReset().mockResolvedValue({ count: 0 });

  mockPrisma.automation.findMany.mockResolvedValue([mockAutomation]);
  mockPrisma.automation.findFirst.mockResolvedValue(null);
  mockPrisma.dmLog.findUnique.mockResolvedValue(null);
  mockPrisma.dmLog.create.mockResolvedValue({});
  // Two different lookups share findFirst: the cross-campaign private-reply
  // check (keyed on status SENT) and the postback's name lookup. Only the
  // latter should resolve by default, or every comment would look like a
  // duplicate of an already-answered one.
  mockPrisma.dmLog.findFirst.mockImplementation(
    async (args: { where?: { status?: string } } = {}) =>
      args.where?.status === "SENT" ? null : { commenterName: "commenter_user" }
  );
  mockPrisma.dmLog.upsert.mockResolvedValue({});
  mockPrisma.dmLog.update.mockReset().mockResolvedValue({});
  mockPrisma.dmLog.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockPrisma.instagramAccount.findUnique.mockResolvedValue({
    workspaceId: "workspace_123",
  });
  mockPrisma.operationalEvent.create.mockResolvedValue({});
  mockDecryptToken.mockReturnValue("decrypted_token");
  mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
  mockReserveWorkspaceDMSend.mockResolvedValue({
    allowed: true,
    reserved: true,
    remaining: 100,
    limit: 2000,
    periodStart: usagePeriodStart,
  });
  mockReserveDMSlot.mockResolvedValue({
    allowed: true,
    currentCount: 11,
    remainingDMs: 179,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  });
  mockReleaseDMSlot.mockResolvedValue(0);
  mockReleaseWorkspaceDMReservation.mockResolvedValue({ count: 1 });
  mockSendPrivateReply.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_001",
  });
  mockSendPrivateReplyWithLinkButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_002",
  });
  mockSendPrivateReplyWithButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_003",
  });
  mockSendDirectMessageWithButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_004",
  });
  mockSendDirectMessage.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_005",
  });
  mockSendDirectMessageWithLinkButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_006",
  });
  mockSendDirectMessageWithEmailQuickReply.mockReset().mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_007",
  });
  mockGetUserFollowStatus.mockResolvedValue(true);
  mockGetUserProfile.mockReset().mockResolvedValue(null);
});

describe("DM Worker — comments left on an ad", () => {
  it("also matches the organic post the ad was created from", async () => {
    const processor = getProcessor();

    // A boosted post: the comment carries the ad's media id, while the
    // campaign is bound to the post the ad was made from. Without the second
    // id in the query the comment matches nothing and is dropped silently.
    await processor(
      createMockJob({
        ...mockJobData,
        mediaId: "ad_media_999",
        originalMediaId: "media_101",
      })
    );

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { postId: "ad_media_999" },
            { postId: "media_101" },
            { matchAnyPost: true },
          ],
        }),
      })
    );
    expect(mockSendPrivateReply).toHaveBeenCalled();
  });
});

describe("DM Worker — Full Pipeline", () => {
  it("should send a private reply for a matching comment", async () => {
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ postId: "media_101" }, { matchAnyPost: true }],
        isActive: true,
        instagramAccount: { instagramId: "ig_456" },
      },
      include: {
        instagramAccount: true,
        workspace: true,
        trackedLinks: {
          select: {
            slug: true,
            label: true,
            destinationUrl: true,
          },
          // Button order: position first, with createdAt and id only as
          // tie breakers, so tied rows can never come back swapped.
          orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(mockMatchKeywords).toHaveBeenCalledWith(
      "I want the LINK!",
      ["LINK", "PRICE"],
      true
    );
    expect(mockReserveWorkspaceDMSend).toHaveBeenCalledWith("workspace_123");
    expect(mockReserveDMSlot).toHaveBeenCalledWith("ig_456", 0);
    // A successful send keeps its slot; the release path is failure-only.
    expect(mockReleaseDMSlot).not.toHaveBeenCalled();
    expect(mockDecryptToken).toHaveBeenCalledWith("encrypted_token_abc");
    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the link: https://example.com"
    );
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "comment_555",
        },
      },
      data: expect.objectContaining({ status: "SENT" }),
    });
  });

  it("should skip when no automations match the media", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
  });

  it("should skip when keywords do not match", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should skip duplicate comments already sent", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      id: "existing_log",
      status: "SENT",
    });
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should skip when monthly plan limit is reached", async () => {
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: false,
      reserved: false,
      remaining: 0,
      limit: 100,
      periodStart: usagePeriodStart,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReserveDMSlot).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_PLAN_LIMIT" }),
      })
    );
  });

  it("should requeue and release monthly usage when rate limited", async () => {
    mockReserveDMSlot.mockResolvedValue({
      allowed: false,
      currentCount: 190,
      remainingDMs: 0,
      shouldRequeue: true,
      requeueDelayMs: 1800000,
      shouldSkip: false,
      reserved: false,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-comment",
      expect.objectContaining({
        commentId: "comment_555",
        requeueAttempt: 1,
      }),
      expect.objectContaining({
        delay: 1800000,
        jobId: "comment_ig_456_comment_555_retry_1",
      })
    );
  });

  it("should skip with SKIPPED_RATE_LIMIT after max requeue attempts", async () => {
    mockReserveDMSlot.mockResolvedValue({
      allowed: false,
      currentCount: 190,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_RATE_LIMIT" }),
      })
    );
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should log FAILED, release usage, and re-throw when private reply sending fails", async () => {
    const error = new RateLimitError("API Error");
    mockSendPrivateReply.mockRejectedValue(error);

    const processor = getProcessor();

    await expect(processor(createMockJob())).rejects.toThrow("API Error");
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "comment_555",
        },
      },
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: "API Error",
      }),
    });
  });

  it("should handle missing access token", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        instagramAccount: {
          ...mockAutomation.instagramAccount,
          accessToken: null,
        },
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        }),
      })
    );
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should use 'there' when commenter name is not available", async () => {
    const processor = getProcessor();
    const jobDataWithoutName = {
      instagramAccountId: mockJobData.instagramAccountId,
      commentId: mockJobData.commentId,
      commentText: mockJobData.commentText,
      commenterId: mockJobData.commenterId,
      mediaId: mockJobData.mediaId,
    };

    await processor(createMockJob(jobDataWithoutName as typeof mockJobData));

    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey there! Here is the link: https://example.com"
    );
  });

  it("should deliver tracked links as web_url buttons (one or two)", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        dmMessage: "Hey {username}! Here is the offer: {link}",
        linkButtonLabel: "Get offer",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
          {
            slug: "def456",
            label: "Book a call",
            destinationUrl: "https://example.com/book",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Primary button title comes from linkButtonLabel; the second from its
    // own stored label. Both point at their tracked /r/<slug> URLs, tagged
    // with the commenter's recipient token.
    const token = hashRecipientId(mockJobData.commenterId);
    expect(mockSendPrivateReplyWithLinkButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the offer:",
      [
        { title: "Get offer", url: `http://localhost:3000/r/abc123?r=${token}` },
        { title: "Book a call", url: `http://localhost:3000/r/def456?r=${token}` },
      ]
    );
  });

  it("should send a follow-gate prompt when a non-follower comments", async () => {
    mockGetUserFollowStatus.mockResolvedValue(false); // not following yet
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        requireFollow: true,
        followPromptMessage: "Follow me first {username}, then tap 👇",
        followPromptButtonLabel: "I'm following ✅",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // The follow prompt goes out with a `followcheck:` postback button; the
    // link is NOT delivered yet.
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Follow me first commenter_user, then tap 👇",
      "I'm following ✅",
      "followcheck:auto_789"
    );
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should skip the prompt and send the link when the commenter already follows", async () => {
    mockGetUserFollowStatus.mockResolvedValue(true); // already following
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        requireFollow: true,
        followPromptMessage: "Follow me first, then tap 👇",
        followPromptButtonLabel: "I'm following ✅",
        dmMessage: "Hey {username}! Here is the offer: {link}",
        linkButtonLabel: "Get offer",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Confirmed follower: no prompt, link delivered right away.
    expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the offer:",
      [
        {
          title: "Get offer",
          url: `http://localhost:3000/r/abc123?r=${hashRecipientId(mockJobData.commenterId)}`,
        },
      ]
    );
  });

  it("should send the opening DM first (routing to the follow check) when both opening DM and follow-gate are on", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        openingDmEnabled: true,
        openingDmMessage: "Hey {username}, welcome!",
        openingDmButtonLabel: "Get the link",
        requireFollow: true,
        followPromptButtonLabel: "I'm following ✅",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Opening DM goes out first; its button routes into the follow check.
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user, welcome!",
      "Get the link",
      "followcheck:auto_789:open"
    );
    // Follow status is verified on the tap, not at comment time.
    expect(mockGetUserFollowStatus).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
  });

  it("should deliver the next DM from a read fallback when no button tap has sent it yet", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockPrisma.dmLog.findUnique).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "reveal:commenter_999",
        },
      },
    });
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
  });

  it("should not deliver a read fallback when the button tap already sent the reveal", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      id: "existing_reveal",
      status: "SENT",
    });

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should not let a read fallback bypass the follow gate", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      trackedLinks: [],
    });
    mockGetUserFollowStatus.mockResolvedValue(false); // still not following

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    // Non-follower on a read fallback: no link, and no re-prompt spam either.
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should not let a read fallback through when follow status is unverifiable", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      trackedLinks: [],
    });
    // Instagram answers "User consent is required" until the person taps a
    // button, which is exactly the case of someone who only read the DM.
    mockGetUserFollowStatus.mockResolvedValue(null);

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
  });

  it("should deliver a follow-gated read fallback once the user follows", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      trackedLinks: [],
    });
    mockGetUserFollowStatus.mockResolvedValue(true);

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
  });

  it("should not log a failure when a read fallback hits a closed messaging window", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockSendDirectMessage.mockRejectedValue(
      new MetaApiError(10, undefined, undefined, "This message is sent outside of allowed window.")
    );

    const processor = getProcessor();
    // The window cannot reopen on its own, so this must not throw (no retries)
    // and must not leave a FAILED row the user can do nothing about.
    await expect(
      processor(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "reveal:auto_789",
          fallback: true,
        })
      )
    ).resolves.toBeUndefined();

    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalled();
  });

  it("should still log a failure for a real button tap that fails", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockSendDirectMessage.mockRejectedValue(new Error("boom"));

    const processor = getProcessor();
    await expect(
      processor(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "reveal:auto_789",
        })
      )
    ).rejects.toThrow("boom");

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: "FAILED" }),
      })
    );
  });
});

describe("DM Worker — one private reply per comment", () => {
  it("should skip a campaign when another already used the comment's private reply", async () => {
    mockPrisma.dmLog.findFirst.mockImplementation(
      async (args: { where?: { status?: string } } = {}) =>
        args.where?.status === "SENT"
          ? { automation: { name: "openreply 1" } }
          : { commenterName: "commenter_user" }
    );

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SKIPPED_DEDUP",
          errorMessage: expect.stringContaining("openreply 1"),
        }),
      })
    );
  });

  it("should not fall back to a plain-text private reply when the window is the problem", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        trackedLinks: [
          {
            slug: "abc123",
            label: null,
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(
      new MetaApiError(100, undefined, undefined, "The comment is invalid for a private reply")
    );

    const processor = getProcessor();
    await expect(processor(createMockJob())).rejects.toThrow(
      "The comment is invalid for a private reply"
    );

    // The reserved rate slot must be handed back when the send fails, so a
    // comment that never delivered a DM does not burn slots on each retry.
    expect(mockReleaseDMSlot).toHaveBeenCalledWith("ig_456");

    // A text retry on the same comment would fail identically and overwrite the
    // real reason, so it must not be attempted.
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          errorMessage: expect.stringContaining("The comment is invalid for a private reply"),
        }),
      })
    );
  });

  it("should still fall back to plain text when the button template itself is rejected", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        trackedLinks: [
          {
            slug: "abc123",
            label: null,
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(
      new MetaApiError(100, undefined, undefined, "Unsupported message template")
    );

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SENT" }),
      })
    );
  });
});

describe("DM Worker — DM keyword trigger", () => {
  const dmTriggerAutomation = {
    ...mockAutomation,
    dmTriggerEnabled: true,
    requireFollow: false,
    followPromptMessage: null,
    followPromptButtonLabel: null,
  };

  function createMockMessageJob(data: Record<string, unknown> = {}) {
    return {
      name: "process-message",
      data: {
        instagramAccountId: "ig_456",
        messageId: "mid_abc",
        messageText: "can I get the LINK?",
        senderId: "commenter_999",
        ...data,
      },
      id: "message_job_001",
      attemptsMade: 0,
    };
  }

  beforeEach(() => {
    mockPrisma.automation.findMany.mockResolvedValue([dmTriggerAutomation]);
  });

  it("should reply to a DM whose text matches the campaign keywords", async () => {
    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dmTriggerEnabled: true,
          isActive: true,
        }),
      })
    );
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
    // Never a private reply — there is no comment to reply to.
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should not reply when the DM text matches no keyword", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });

    const processor = getProcessor();
    await processor(createMockMessageJob({ messageText: "hello there" }));

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithLinkButton).not.toHaveBeenCalled();
  });

  it("should log the reply against the inbound message id for dedup", async () => {
    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          automationId_commentId: {
            automationId: "auto_789",
            commentId: "dm:mid_abc",
          },
        },
        create: expect.objectContaining({
          commenterId: "commenter_999",
          commentText: "can I get the LINK?",
          matchedKeyword: "LINK",
          status: "SENT",
        }),
      })
    );
  });

  it("should not re-send when this message was already answered", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "SENT" });

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should send the link as buttons when the campaign has tracked links", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...dmTriggerAutomation,
        linkButtonLabel: "Get it",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Get it",
            destinationUrl: "https://example.com/offer",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithLinkButton).toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("should send the follow prompt instead of the link to a non-follower", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...dmTriggerAutomation, requireFollow: true },
    ]);
    mockGetUserFollowStatus.mockResolvedValue(false);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      expect.any(String),
      "I'm following ✅",
      "followcheck:auto_789"
    );
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  // First contact, so the gate is fail-closed like processComment: an
  // unverifiable status must not hand out the link.
  it("should send the follow prompt when follow status cannot be verified", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...dmTriggerAutomation, requireFollow: true },
    ]);
    mockGetUserFollowStatus.mockResolvedValue(null);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithButton).toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("should skip and log when the workspace is over its monthly limit", async () => {
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: false,
      reserved: false,
      remaining: 0,
      limit: 2000,
      periodStart: usagePeriodStart,
    });

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "SKIPPED_PLAN_LIMIT" }),
      })
    );
  });

  describe("AI draft hand-off", () => {
    it("does not ask for an AI draft when a campaign matched", async () => {
      await getProcessor()(createMockMessageJob());

      expect(mockSendDirectMessage).toHaveBeenCalled();
      expect(mockMaybeEnqueueAiDraft).not.toHaveBeenCalled();
    });

    it("does not ask for an AI draft when a matched campaign skips an already answered message", async () => {
      mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "SENT" });

      await getProcessor()(createMockMessageJob());

      expect(mockMaybeEnqueueAiDraft).not.toHaveBeenCalled();
    });

    it("hands an unmatched message to the AI assistant with its receive time", async () => {
      mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
      const job = { ...createMockMessageJob({ messageText: "請問課程多少錢？" }), timestamp: 1_760_000_000_000 };

      await getProcessor()(job);

      expect(mockSendDirectMessage).not.toHaveBeenCalled();
      expect(mockMaybeEnqueueAiDraft).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "mid_abc", messageText: "請問課程多少錢？" }),
        1_760_000_000_000
      );
    });

    it("hands it over when the account has no DM campaigns at all", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([]);

      await getProcessor()(createMockMessageJob({ messageText: "hi" }));

      expect(mockMaybeEnqueueAiDraft).toHaveBeenCalledTimes(1);
    });

    it("never fails the campaign job when queueing the AI draft fails", async () => {
      mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
      mockMaybeEnqueueAiDraft.mockRejectedValueOnce(new Error("redis down"));

      await expect(getProcessor()(createMockMessageJob())).resolves.toBeUndefined();
    });
  });

  it("should release the usage reservation and rethrow when the send fails", async () => {
    mockSendDirectMessage.mockRejectedValue(new Error("Meta is down"));

    const processor = getProcessor();
    await expect(processor(createMockMessageJob())).rejects.toThrow(
      "Meta is down"
    );

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "FAILED" }),
      })
    );
  });
});

describe("Zernio worker routing", () => {
  it("fails open on unknown follow status and sends once through the selected provider", async () => {
    mockPrisma.zernioConnection.findUnique.mockResolvedValue({
      apiKey: "encrypted_key",
    });
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        requireFollow: true,
        instagramAccount: {
          ...mockAutomation.instagramAccount,
          provider: "ZERNIO",
          workspaceId: "workspace_123",
          zernioAccountId: "zernio_selected",
          accessToken: "",
        },
      },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            isFollower: null,
            unavailableReason: "consent_required",
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messageId: "sent" }))
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await getProcessor()(createMockJob());
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain(
        "/inbox/comments/media_101/comment_555/private-reply"
      );
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).accountId).toBe(
        "zernio_selected"
      );
      expect(mockSendPrivateReply).not.toHaveBeenCalled();
      expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
      expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "SENT" }),
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it("stops BullMQ retries after an ambiguous Zernio direct-message outcome", async () => {
  mockPrisma.zernioConnection.findUnique.mockResolvedValue({
    apiKey: "encrypted",
  });
  mockPrisma.automation.findFirst.mockResolvedValue({
    ...mockAutomation,
    instagramAccount: {
      ...mockAutomation.instagramAccount,
      provider: "ZERNIO",
      workspaceId: "workspace_123",
      zernioAccountId: "remote",
      accessToken: "",
    },
  });
  const fetchMock = vi.fn().mockRejectedValue(new Error("connection reset"));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await expect(getProcessor()(createMockPostbackJob())).rejects.toMatchObject(
      {
        name: "UnrecoverableError",
        message: expect.stringContaining("Inspect the Instagram inbox"),
      }
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('binds queued comments to the local connection that received them', async () => {
  mockPrisma.automation.findMany.mockResolvedValue([]);
  const job = createMockJob();
  Object.assign(job.data, { accountConnectionId: 'original-connection' });
  await getProcessor()(job);
  expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ instagramAccountId: 'original-connection' }) }));
});

it('never automatically resends a private reply with an unconfirmed delivery', async () => {
  mockPrisma.dmLog.findUnique.mockResolvedValue({ status: 'FAILED', dmDeliveryUnconfirmed: true, publicReplySentAt: null });
  await getProcessor()(createMockJob());
  expect(mockSendPrivateReply).not.toHaveBeenCalled();
  expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
  expect(mockPrisma.dmLog.update).not.toHaveBeenCalled();
});

it('keeps an unconfirmed public reply untouched after the DM was delivered', async () => {
  mockPrisma.automation.findMany.mockResolvedValue([{ ...mockAutomation, publicReplyEnabled: true, publicReplyMessage: 'Thanks!', publicReplyMessages: [] }]);
  mockPrisma.dmLog.findUnique.mockResolvedValue({ status: 'SENT', publicReplyDeliveryUnconfirmed: true, publicReplySentAt: null });
  await getProcessor()(createMockJob());
  expect(mockPrisma.dmLog.update).not.toHaveBeenCalled();
});

describe("durable Zernio postback delivery", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    const claims = new Set<string>();
    mockPrisma.postbackDelivery.create.mockImplementation(
      async ({ data }: { data: { id: string } }) => {
        if (claims.has(data.id)) throw { code: "P2002" };
        claims.add(data.id);
        return data;
      },
    );
    mockPrisma.postbackDelivery.delete.mockImplementation(
      async ({ where }: { where: { id: string } }) => {
        claims.delete(where.id);
      },
    );
    mockPrisma.zernioConnection.findUnique.mockResolvedValue({
      apiKey: "encrypted",
    });
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      instagramAccount: {
        ...mockAutomation.instagramAccount,
        provider: "ZERNIO",
        workspaceId: "workspace_123",
        zernioAccountId: "remote",
        accessToken: "",
      },
    });
    fetchMock = vi.fn();
  });

  function tap(mid: string) {
    return createMockPostbackJob({
      instagramAccountId: "ig_456",
      userId: "commenter_999",
      payload: "reveal:auto_789",
      mid,
    });
  }

  it("retains an uncertain tap across a newer successful tap and queue eviction", async () => {
    fetchMock
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ data: { messageId: "new-tap" } })),
      )
      .mockRejectedValueOnce(new Error("connection reset"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      await expect(process(tap("old"))).rejects.toMatchObject({
        name: "UnrecoverableError",
      });
      await process(tap("new"));
      await process({ ...tap("old"), id: "redelivery-job" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockPrisma.postbackDelivery.delete).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deduplicates successful old taps while permitting each distinct new mid", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ data: { messageId: "sent" } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      await process(tap("first"));
      await process(tap("second"));
      await process({ ...tap("first"), id: "after-retention" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("releases a claim on a confirmed rejection so the same tap can retry", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { messageId: "sent" } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      await expect(process(tap("retry"))).rejects.toThrow();
      await process(tap("retry"));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockPrisma.postbackDelivery.delete).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("claims concurrent deliveries of the same tap before either can send twice", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ data: { messageId: "sent" } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      await Promise.all([
        process(tap("concurrent")),
        process({ ...tap("concurrent"), id: "other-job" }),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deduplicates follow-gate prompts as well as reveal messages", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      instagramAccount: {
        ...mockAutomation.instagramAccount,
        provider: "ZERNIO",
        workspaceId: "workspace_123",
        zernioAccountId: "remote",
        accessToken: "",
      },
    });
    fetchMock.mockImplementation(
      async (_url: string, init: { method: string }) =>
        new Response(
          JSON.stringify(
            init.method === "GET"
              ? { isFollower: false }
              : { data: { messageId: "prompt" } },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      const followTap = tap("follow");
      // The prompt goes out on the last delayed re-check — an earlier false
      // only queues the next one — so exercise that pass: that is where the
      // prompt is sent, and where a redelivery must not send it a second time.
      followTap.data = {
        ...followTap.data,
        payload: "followcheck:auto_789",
        followRecheck: true,
        followRecheckAttempt: 2,
      };
      await process(followTap);
      await process({ ...followTap, id: "redelivery" });
      expect(
        fetchMock.mock.calls.filter(([, init]) => init.method === "POST"),
      ).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("DM Worker — follow-gate re-check", () => {
  const gated = { ...mockAutomation, requireFollow: true, trackedLinks: [] };

  it("re-checks a first false follow later instead of rejecting the tap", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
      })
    );

    // Nothing is sent yet: a brand-new follow may simply not have registered.
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheck: true, userId: "commenter_999" }),
      expect.objectContaining({ delay: expect.any(Number) })
    );
  });

  it("prompts and records the rejection when the last re-check still finds no follow", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
        followRecheck: true,
        followRecheckAttempt: 2,
      })
    );

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(1);
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          message: "Follow gate rejected a button tap",
        }),
      })
    );
    // A re-check never queues another re-check.
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("buckets the re-check id by time so a later tap is not blocked by an old job", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
      })
    );

    const [, , opts] = mockQueueAdd.mock.calls[0];
    // A fixed per-user id would collide with the retained completed job of an
    // earlier re-check and be dropped silently by BullMQ.
    expect(opts.jobId).toMatch(/^postback_recheck_auto_789_commenter_999_1_\d+$/);
  });

  it("checks twice: soon after the tap, then again before giving up", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);
    const tap = {
      instagramAccountId: "ig_456",
      userId: "commenter_999",
      payload: "followcheck:auto_789",
    };

    await getProcessor()(createMockPostbackJob(tap));
    expect(mockQueueAdd).toHaveBeenLastCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 1 }),
      expect.objectContaining({ delay: 20_000 })
    );

    await getProcessor()(
      createMockPostbackJob({ ...tap, followRecheck: true, followRecheckAttempt: 1 })
    );
    expect(mockQueueAdd).toHaveBeenLastCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 2 }),
      expect.objectContaining({ delay: 40_000 })
    );
    // Neither pass has given up yet, so neither re-sends the prompt.
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
  });

  it("treats a re-check queued before counting existed as the first one done", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
        followRecheck: true,
      })
    );

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 2 }),
      expect.anything()
    );
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
  });

  it("prompts a non-follower right away when the tap came from the opening DM", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789:open",
      })
    );

    // Tapping the opening DM is not a claim to follow, so there is nothing to
    // wait for: the follow prompt goes out now, not after the re-check delay.
    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      expect.any(String),
      expect.any(String),
      "followcheck:auto_789"
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
    // Nor is it a rejection: they were never told to follow before this.
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });
});

describe("DM Worker — follow re-check acknowledgement", () => {
  const gated = { ...mockAutomation, requireFollow: true, trackedLinks: [] };
  const tap = {
    instagramAccountId: "ig_456",
    userId: "commenter_999",
    payload: "followcheck:auto_789",
  };
  const mockRedisSet = vi.fn();

  beforeEach(() => {
    process.env.FOLLOW_RECHECK_ACK_MESSAGE = "Dame unos segundos que lo verifico";
    mockRedisSet.mockReset().mockResolvedValue("OK");
    vi.mocked(getRedisConnection).mockReturnValue({ set: mockRedisSet } as never);
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);
  });

  afterEach(() => {
    delete process.env.FOLLOW_RECHECK_ACK_MESSAGE;
  });

  it("answers a not-yet-visible follow right away instead of leaving the chat silent", async () => {
    await getProcessor()(createMockPostbackJob(tap));

    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Dame unos segundos que lo verifico"
    );
    // The re-check is still what decides; the acknowledgement only fills the wait.
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 1 }),
      expect.anything()
    );
  });

  it("acknowledges a burst of taps only once", async () => {
    mockRedisSet.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    await getProcessor()(createMockPostbackJob(tap));
    await getProcessor()(createMockPostbackJob(tap));

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge again on the re-check passes", async () => {
    await getProcessor()(
      createMockPostbackJob({ ...tap, followRecheck: true, followRecheckAttempt: 1 })
    );

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("still re-checks when the acknowledgement cannot be sent", async () => {
    mockSendDirectMessage.mockRejectedValueOnce(new Error("boom"));

    await expect(getProcessor()(createMockPostbackJob(tap))).resolves.toBeUndefined();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 1 }),
      expect.anything()
    );
  });

  it("sends nothing extra when no acknowledgement message is configured", async () => {
    delete process.env.FOLLOW_RECHECK_ACK_MESSAGE;

    await getProcessor()(createMockPostbackJob(tap));

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });
});

describe("ambiguous Meta sends and durable comment claims", () => {
  const withLinks = { ...mockAutomation, trackedLinks: [{ slug: "resource", label: null, destinationUrl: "https://example.com" }] };

  it("never falls back or retries Meta code 1, even though Meta may have sent the message", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([withLinks]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(new MetaApiError(1, undefined, undefined, "An unknown error has occurred."));
    await expect(getProcessor()(createMockJob())).rejects.toMatchObject({ name: "UnrecoverableError" });
    expect(mockSendPrivateReplyWithLinkButton).toHaveBeenCalledTimes(1);
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", dmDeliveryUnconfirmed: true }) }));
    expect(mockReleaseDMSlot).not.toHaveBeenCalled();
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
  });

  it("retains the fallback's uncertain outcome instead of replacing it with the first rejection", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([withLinks]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(new MetaApiError(100, undefined, undefined, "Unsupported message template"));
    mockSendPrivateReply.mockRejectedValue(new Error("Connection reset after send"));
    await expect(getProcessor()(createMockJob())).rejects.toMatchObject({ name: "UnrecoverableError", message: expect.stringContaining("Connection reset after send") });
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ dmDeliveryUnconfirmed: true }) }));
  });

  it("blocks the historical code 1 failures before any further network send", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "FAILED", attempts: 1, errorMessage: "MetaApiError 1: An unknown error has occurred.", dmDeliveryUnconfirmed: false });
    await getProcessor()(createMockJob());
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: { dmDeliveryUnconfirmed: true } }));
  });

  it("cannot reset the lifetime attempt limit by enqueueing a new job", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "FAILED", attempts: 3, dmDeliveryUnconfirmed: false });
    await getProcessor()({ ...createMockJob(), id: "new-poll-job", attemptsMade: 0 });
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.updateMany).not.toHaveBeenCalled();
  });

  it("allows only the claim winner to send when webhook and polling overlap", async () => {
    let claimed = false;
    mockPrisma.dmLog.updateMany.mockImplementation(async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });
    const process = getProcessor();
    await Promise.all([process(createMockJob()), process({ ...createMockJob(), id: "poll-job" })]);
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });

  it("keeps the pre-send claim when both success and failure log writes fail", async () => {
    mockPrisma.dmLog.update.mockRejectedValue(new Error("Database unavailable"));
    const process = getProcessor();
    await expect(process(createMockJob())).rejects.toThrow("Database unavailable");
    expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ dmDeliveryUnconfirmed: true }) }));
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "PENDING", attempts: 1, dmDeliveryUnconfirmed: true });
    await process({ ...createMockJob(), id: "retry-after-db-recovers" });
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
  });

  it("does not send at all when storing the claim fails", async () => {
    mockPrisma.dmLog.updateMany.mockRejectedValue(new Error("Database unavailable"));
    await expect(getProcessor()(createMockJob())).rejects.toThrow("Database unavailable");
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });
});

it("deduplicates a redelivered Meta button tap after queue retention expires", async () => {
  const claims = new Set<string>();
  mockPrisma.postbackDelivery.create.mockImplementation(async ({ data }: { data: { id: string } }) => {
    if (claims.has(data.id)) throw { code: "P2002" };
    claims.add(data.id);
    return data;
  });
  mockPrisma.automation.findFirst.mockResolvedValue(mockAutomation);
  const data = { instagramAccountId: "ig_456", userId: "commenter_999", payload: "reveal:auto_789", mid: "same-meta-tap" };
  const process = getProcessor();
  await process(createMockPostbackJob(data));
  await process({ ...createMockPostbackJob(data), id: "redelivered-after-eviction" });
  expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
});

it("retains the public reply claim if sending succeeded but its log write failed", async () => {
  const { sendCommentReply } = await import("@/lib/meta/client");
  vi.mocked(sendCommentReply).mockResolvedValue({ id: "public-reply" });
  mockPrisma.automation.findMany.mockResolvedValue([{ ...mockAutomation, publicReplyEnabled: true, publicReplyMessages: ["Sent!"] }]);
  mockPrisma.dmLog.update.mockRejectedValueOnce(new Error("Lost database connection after public send"));
  const process = getProcessor();
  await process(createMockJob());
  expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ publicReplyDeliveryUnconfirmed: true }) }));
  mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "SENT", publicReplyDeliveryUnconfirmed: true });
  await process({ ...createMockJob(), id: "next-poll" });
  expect(sendCommentReply).toHaveBeenCalledTimes(1);
  expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
});

describe("DM Worker — email gate", () => {
  type FakeContact = {
    id: string;
    workspaceId: string;
    instagramAccountId: string;
    igsid: string;
    username: string | null;
    name: string | null;
    followerCount: number | null;
    followsYou: boolean | null;
    profileCheckedAt: Date | null;
    lastTriggerType: string | null;
    lastTriggerText: string | null;
    lastTriggerMediaId: string | null;
    lastTriggerKeyword: string | null;
    lastTriggerAt: Date | null;
    email: string | null;
    emailCapturedAt: Date | null;
    emailAutomationId: string | null;
    emailSource: string | null;
    emailConsentText: string | null;
    emailSourceType: string | null;
    emailSourceText: string | null;
    emailSourceMediaId: string | null;
    emailSourceKeyword: string | null;
    emailOptedOutAt: Date | null;
    pendingEmailAutomationId: string | null;
    pendingEmailPrompt: string | null;
    pendingEmailAttempts: number;
    pendingEmailExpiresAt: Date | null;
    pendingEmailSilenced: boolean;
    firstSeenAt: Date;
    lastInteractionAt: Date;
  };

  const IN_A_DAY = () => new Date(Date.now() + 24 * 60 * 60 * 1000);
  const LINK_TEXT = "Hey commenter_user! Here is the link: https://example.com";

  const gated = {
    ...mockAutomation,
    collectEmail: true,
    emailPromptMessage: null,
    emailInvalidMessage: null,
    emailThanksMessage: null,
    emailQuickReplyEnabled: true,
    requireFollow: false,
    followUpEnabled: false,
  };

  let contacts: FakeContact[];
  let claims: Set<string>;

  // A small in-memory stand-in for the Contact table: equality filters only,
  // which is all the gate's compare-and-set writes use. Each call runs to
  // completion before the next, like a single-row atomic update.
  function matches(row: FakeContact, where: Record<string, unknown>) {
    return Object.entries(where).every(([key, value]) => {
      if (key === "instagramAccount") return true;
      if (key === "instagramAccountId_igsid") {
        const compound = value as { instagramAccountId: string; igsid: string };
        return (
          row.instagramAccountId === compound.instagramAccountId &&
          row.igsid === compound.igsid
        );
      }
      const actual = (row as Record<string, unknown>)[key];
      if (value instanceof Date) {
        return actual instanceof Date && actual.getTime() === value.getTime();
      }
      return actual === value;
    });
  }

  function seedContact(fields: Partial<FakeContact> = {}): FakeContact {
    const row: FakeContact = {
      id: `contact_${contacts.length + 1}`,
      workspaceId: "workspace_123",
      instagramAccountId: "ig_account_row_1",
      igsid: "commenter_999",
      username: "commenter_user",
      name: null,
      followerCount: null,
      followsYou: null,
      profileCheckedAt: null,
      lastTriggerType: null,
      lastTriggerText: null,
      lastTriggerMediaId: null,
      lastTriggerKeyword: null,
      lastTriggerAt: null,
      email: null,
      emailCapturedAt: null,
      emailAutomationId: null,
      emailSource: null,
      emailConsentText: null,
      emailSourceType: null,
      emailSourceText: null,
      emailSourceMediaId: null,
      emailSourceKeyword: null,
      emailOptedOutAt: null,
      pendingEmailAutomationId: null,
      pendingEmailPrompt: null,
      pendingEmailAttempts: 0,
      pendingEmailExpiresAt: null,
      pendingEmailSilenced: false,
      firstSeenAt: new Date(),
      lastInteractionAt: new Date(),
      ...fields,
    };
    contacts.push(row);
    return row;
  }

  function openGate(fields: Partial<FakeContact> = {}) {
    return seedContact({
      pendingEmailAutomationId: "auto_789",
      pendingEmailPrompt: "ASK SENT EARLIER",
      pendingEmailExpiresAt: IN_A_DAY(),
      ...fields,
    });
  }

  function messageJob(text: string, extra: Record<string, unknown> = {}) {
    return {
      name: "process-message",
      data: {
        instagramAccountId: "ig_456",
        accountConnectionId: "ig_account_row_1",
        messageId: "mid_email_1",
        messageText: text,
        senderId: "commenter_999",
        ...extra,
      },
      id: `message_job_${String(extra.messageId ?? "1")}`,
      attemptsMade: 0,
    };
  }

  function directTexts() {
    return mockSendDirectMessage.mock.calls.map((call) => call[3]);
  }

  beforeEach(() => {
    contacts = [];
    claims = new Set();
    mockPrisma.contact.findFirst.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) => {
        const row = contacts.find((c) => matches(c, where));
        return row ? { ...row } : null;
      }
    );
    mockPrisma.contact.findUnique.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) => {
        const row = contacts.find((c) => matches(c, where));
        return row ? { ...row } : null;
      }
    );
    mockPrisma.contact.upsert.mockImplementation(
      async ({
        where,
        create,
        update,
      }: {
        where: Record<string, unknown>;
        create: Partial<FakeContact>;
        update: Partial<FakeContact>;
      }) => {
        const row = contacts.find((c) => matches(c, where));
        if (row) {
          Object.assign(row, update);
          return { ...row };
        }
        return { ...seedContact(create) };
      }
    );
    mockPrisma.contact.updateMany.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<FakeContact>;
      }) => {
        const rows = contacts.filter((c) => matches(c, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }
    );
    mockPrisma.postbackDelivery.create.mockImplementation(
      async ({ data }: { data: { id: string } }) => {
        if (claims.has(data.id)) throw { code: "P2002" };
        claims.add(data.id);
        return data;
      }
    );
    mockPrisma.postbackDelivery.delete.mockImplementation(
      async ({ where }: { where: { id: string } }) => {
        claims.delete(where.id);
      }
    );
    mockPrisma.postbackDelivery.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        claims.has(where.id) ? { id: where.id } : null
    );
    // The gate's campaign is loaded by id; DM-trigger campaigns by findMany.
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
  });

  describe("starting the gate", () => {
    it("asks for the email in the comment's private reply instead of sending the link", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([gated]);
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });

      await getProcessor()(createMockJob());

      // The one private reply this comment allows is the ask, as plain text
      // and without the hint about a quick-reply button it cannot carry.
      expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
      expect(mockSendPrivateReply).toHaveBeenCalledWith(
        "decrypted_token",
        "ig_456",
        "comment_555",
        defaultEmailPrompt(false)
      );
      expect(defaultEmailPrompt(false)).not.toContain("按鈕");
      expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
      // The comment still counts as answered, so the reconciler leaves it be.
      expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "SENT" }),
        })
      );
      expect(contacts).toHaveLength(1);
      expect(contacts[0]).toMatchObject({
        username: "commenter_user",
        email: null,
        pendingEmailAutomationId: "auto_789",
        pendingEmailPrompt: defaultEmailPrompt(false),
        pendingEmailAttempts: 0,
        pendingEmailSilenced: false,
      });
      const ttl = contacts[0].pendingEmailExpiresAt!.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
      expect(ttl).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    });

    it("does not open the gate when the ask is rejected outright", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([gated]);
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
      mockSendPrivateReply.mockRejectedValue(new RateLimitError("slow down"));

      await expect(getProcessor()(createMockJob())).rejects.toThrow("slow down");

      expect(contacts[0]?.pendingEmailAutomationId ?? null).toBeNull();
    });

    it("skips the ask and sends the link to someone whose email is already known", async () => {
      seedContact({ email: "known@example.com", emailCapturedAt: new Date() });
      mockPrisma.automation.findMany.mockResolvedValue([gated]);
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });

      await getProcessor()(createMockJob());

      expect(mockSendPrivateReply).toHaveBeenCalledWith(
        "decrypted_token",
        "ig_456",
        "comment_555",
        LINK_TEXT
      );
      expect(contacts[0].pendingEmailAutomationId).toBeNull();
    });

    it("asks by DM, with the one-tap email button, after a button tap passes the follow gate", async () => {
      mockPrisma.automation.findFirst.mockResolvedValue({
        ...gated,
        requireFollow: true,
      });
      mockGetUserFollowStatus.mockResolvedValue(true);

      await getProcessor()(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "followcheck:auto_789",
          mid: "tap_1",
        })
      );

      expect(mockSendDirectMessage).toHaveBeenCalledWith(
        "decrypted_token",
        "ig_456",
        "commenter_999", defaultEmailPrompt(false)
      );
      // No link, and no usage reserved for one.
      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
      expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
      expect(contacts[0]).toMatchObject({
        pendingEmailAutomationId: "auto_789",
        pendingEmailPrompt: defaultEmailPrompt(false),
      });
    });

    it("still follows the follow gate first: a non-follower tapping the opening DM gets the follow prompt", async () => {
      mockPrisma.automation.findFirst.mockResolvedValue({
        ...gated,
        requireFollow: true,
      });
      mockGetUserFollowStatus.mockResolvedValue(false);

      await getProcessor()(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "followcheck:auto_789:open",
        })
      );

      expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
        "decrypted_token",
        "ig_456",
        "commenter_999",
        expect.any(String),
        expect.any(String),
        "followcheck:auto_789"
      );
      expect(mockSendDirectMessageWithEmailQuickReply).not.toHaveBeenCalled();
      expect(contacts).toHaveLength(0);
    });

    it("sends the ask as plain text, without the button hint, when the quick reply is off", async () => {
      mockPrisma.automation.findFirst.mockResolvedValue({
        ...gated,
        emailQuickReplyEnabled: false,
      });

      await getProcessor()(createMockPostbackJob());

      expect(mockSendDirectMessageWithEmailQuickReply).not.toHaveBeenCalled();
      expect(mockSendDirectMessage).toHaveBeenCalledWith(
        "decrypted_token",
        "ig_456",
        "commenter_999",
        defaultEmailPrompt(false)
      );
    });

    it("does nothing on a read fallback while the email is unknown", async () => {
      await getProcessor()(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "reveal:auto_789",
          fallback: true,
        })
      );

      expect(mockSendDirectMessage).not.toHaveBeenCalled();
      expect(mockSendDirectMessageWithEmailQuickReply).not.toHaveBeenCalled();
      expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
      expect(contacts).toHaveLength(0);
    });

    it("lets a read fallback deliver once the email is known", async () => {
      seedContact({ email: "known@example.com", emailCapturedAt: new Date() });

      await getProcessor()(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "reveal:auto_789",
          fallback: true,
        })
      );

      expect(directTexts()).toEqual([LINK_TEXT]);
    });

    it("asks instead of sending the link on a DM keyword trigger", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([
        { ...gated, dmTriggerEnabled: true },
      ]);
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });

      await getProcessor()(messageJob("can I get the LINK?"));

      expect(mockSendDirectMessage).toHaveBeenCalledWith(
        "decrypted_token",
        "ig_456",
        "commenter_999", defaultEmailPrompt(false)
      );
      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            automationId_commentId: {
              automationId: "auto_789",
              commentId: "dm:mid_email_1",
            },
          },
          create: expect.objectContaining({ status: "SENT" }),
        })
      );
      expect(contacts[0].pendingEmailAutomationId).toBe("auto_789");
    });

    it("keeps every outbound gate message within Instagram's 1000-byte limit", async () => {
      mockPrisma.automation.findFirst.mockResolvedValue({
        ...gated,
        emailPromptMessage: "請留下 Email 📩".repeat(200),
      });

      await getProcessor()(createMockPostbackJob());

      const sent = mockSendDirectMessage.mock.calls[0][3];
      expect(new TextEncoder().encode(sent).length).toBeLessThanOrEqual(1000);
      expect(sent).not.toMatch(/�/);
      expect(contacts[0].pendingEmailPrompt).toBe(sent);
    });
  });

  describe("answering an open gate", () => {
    it("stores a valid email, thanks once and then delivers the link", async () => {
      openGate();

      await getProcessor()(messageJob("我的信箱是 Leo@Gmail.com 謝謝"));

      // The gate answered the message, so the AI assistant never sees it.
      expect(mockMaybeEnqueueAiDraft).not.toHaveBeenCalled();

      expect(contacts[0]).toMatchObject({
        email: "leo@gmail.com",
        emailSource: "typed",
        emailAutomationId: "auto_789",
        emailConsentText: "ASK SENT EARLIER",
        pendingEmailAutomationId: null,
        pendingEmailExpiresAt: null,
      });
      expect(contacts[0].emailCapturedAt).toBeInstanceOf(Date);
      // Thanks first, then the campaign's own link, through the reveal path.
      expect(directTexts()).toEqual([
        "收到 leo@gmail.com ✅ 連結馬上傳給你！",
        LINK_TEXT,
      ]);
      expect(mockReserveWorkspaceDMSend).toHaveBeenCalledTimes(1);
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            automationId_commentId: {
              automationId: "auto_789",
              commentId: "reveal:commenter_999",
            },
          },
          create: expect.objectContaining({
            status: "SENT",
            commentText: "(email reply)",
          }),
        })
      );
    });

    it("schedules the follow-up after the link, as a button tap does", async () => {
      mockPrisma.automation.findFirst.mockResolvedValue({
        ...gated,
        followUpEnabled: true,
        followUpMessage: "thanks for grabbing it",
        followUpDelayMinutes: 5,
      });
      openGate();

      await getProcessor()(messageJob("leo@gmail.com"));

      expect(mockQueueAdd).toHaveBeenCalledWith(
        "process-followup",
        expect.objectContaining({ userId: "commenter_999", automationId: "auto_789" }),
        expect.objectContaining({ delay: 5 * 60_000, jobId: "followup_auto_789_commenter_999" })
      );
    });

    it("reads a full-width email typed with a Chinese IME", async () => {
      openGate();

      await getProcessor()(messageJob("ａｂｃ＠ｇｍａｉｌ．ｃｏｍ"));

      expect(contacts[0].email).toBe("abc@gmail.com");
      expect(directTexts()).toContain(LINK_TEXT);
    });

    it("records an email tapped from the quick reply as such", async () => {
      openGate();

      await getProcessor()(messageJob("leo@gmail.com", { fromQuickReply: true }));

      expect(contacts[0]).toMatchObject({
        email: "leo@gmail.com",
        emailSource: "quick_reply",
      });
    });

    it("captures an email reply even when it contains another campaign's keyword", async () => {
      const other = {
        ...mockAutomation,
        id: "auto_other",
        dmTriggerEnabled: true,
        keywords: ["link"],
      };
      mockPrisma.automation.findMany.mockResolvedValue([other]);
      // The matcher reads "link@gmail.com" as the words "link gmail com".
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "link" });
      openGate();

      await getProcessor()(messageJob("link@gmail.com"));

      expect(contacts[0].email).toBe("link@gmail.com");
      expect(directTexts()).toEqual([
        "收到 link@gmail.com ✅ 連結馬上傳給你！",
        LINK_TEXT,
      ]);
      expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ automationId: "auto_other" }),
        })
      );
    });

    it("does not let a match-any-word DM campaign steal a valid email reply", async () => {
      const anyWord = {
        ...mockAutomation,
        id: "auto_any",
        dmTriggerEnabled: true,
        matchAnyWord: true,
        keywords: [],
      };
      mockPrisma.automation.findMany.mockResolvedValue([anyWord]);
      openGate();

      await getProcessor()(messageJob("abc@gmail.com"));

      expect(contacts[0].email).toBe("abc@gmail.com");
      expect(directTexts()).toEqual([
        "收到 abc@gmail.com ✅ 連結馬上傳給你！",
        LINK_TEXT,
      ]);
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ automationId: "auto_789" }),
        })
      );
    });

    it("does not let a match-any-word campaign end the gate on a reply without an email", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([
        { ...mockAutomation, id: "auto_any", dmTriggerEnabled: true, matchAnyWord: true },
      ]);
      openGate();

      await getProcessor()(messageJob("我不想給"));

      expect(contacts[0]).toMatchObject({
        pendingEmailAutomationId: "auto_789",
        pendingEmailAttempts: 1,
      });
      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
      expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
    });

    it("re-prompts and counts replies without an email", async () => {
      openGate();
      const process = getProcessor();

      await process(messageJob("我不想給", { messageId: "mid_1" }));
      expect(contacts[0].pendingEmailAttempts).toBe(1);
      // Not an email attempt: the ask again, with the one-tap button.
      expect(mockSendDirectMessage).toHaveBeenLastCalledWith(
        "decrypted_token",
        "ig_456",
        "commenter_999", defaultEmailPrompt(false)
      );

      await process(messageJob("abc@gmail", { messageId: "mid_2" }));
      expect(contacts[0].pendingEmailAttempts).toBe(2);
      // Looks like a mistyped email: the invalid-email message.
      expect(mockSendDirectMessage).toHaveBeenLastCalledWith(
        "decrypted_token",
        "ig_456",
        "commenter_999", DEFAULT_EMAIL_INVALID_MESSAGE
      );
      expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
      expect(contacts[0].pendingEmailSilenced).toBe(false);
    });

    it("goes quiet after the 4th reply without an email, and hands later messages to the keyword campaigns", async () => {
      const keywordCampaign = {
        ...mockAutomation,
        id: "auto_dm",
        dmTriggerEnabled: true,
        keywords: ["LINK"],
      };
      mockPrisma.automation.findMany.mockResolvedValue([keywordCampaign]);
      openGate({ pendingEmailAttempts: 3 });
      const process = getProcessor();

      await process(messageJob("nope", { messageId: "mid_4" }));
      expect(contacts[0]).toMatchObject({
        pendingEmailAttempts: 4,
        pendingEmailSilenced: true,
      });
      expect(mockSendDirectMessageWithEmailQuickReply).not.toHaveBeenCalled();
      expect(mockSendDirectMessage).not.toHaveBeenCalled();

      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
      await process(messageJob("LINK please", { messageId: "mid_5" }));
      expect(directTexts()).toEqual([LINK_TEXT]);
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            automationId_commentId: {
              automationId: "auto_dm",
              commentId: "dm:mid_5",
            },
          },
        })
      );
    });

    it("drops the gate when the reply is another DM campaign's keyword", async () => {
      const keywordCampaign = {
        ...mockAutomation,
        id: "auto_dm",
        dmTriggerEnabled: true,
        keywords: ["PRICE"],
      };
      mockPrisma.automation.findMany.mockResolvedValue([keywordCampaign]);
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "PRICE" });
      openGate();

      await getProcessor()(messageJob("PRICE?"));

      expect(contacts[0].pendingEmailAutomationId).toBeNull();
      expect(directTexts()).toEqual([LINK_TEXT]);
      expect(mockSendDirectMessageWithEmailQuickReply).not.toHaveBeenCalled();
    });

    it("clears an expired gate and treats the message as an ordinary DM", async () => {
      const keywordCampaign = {
        ...mockAutomation,
        id: "auto_dm",
        dmTriggerEnabled: true,
      };
      mockPrisma.automation.findMany.mockResolvedValue([keywordCampaign]);
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
      openGate({ pendingEmailExpiresAt: new Date(Date.now() - 1000) });

      await getProcessor()(messageJob("abc@gmail.com LINK"));

      expect(contacts[0]).toMatchObject({
        email: null,
        pendingEmailAutomationId: null,
      });
      expect(directTexts()).toEqual([LINK_TEXT]);
    });

    it("clears the gate when its campaign stopped collecting emails", async () => {
      mockPrisma.automation.findFirst.mockResolvedValue({ ...gated, collectEmail: false });
      openGate();

      await getProcessor()(messageJob("abc@gmail.com"));

      expect(contacts[0]).toMatchObject({ email: null, pendingEmailAutomationId: null });
      expect(mockSendDirectMessage).not.toHaveBeenCalled();
    });

    it("does not double-send when Meta delivers the same message twice", async () => {
      openGate();
      const process = getProcessor();

      await process(messageJob("leo@gmail.com", { messageId: "mid_dup" }));
      // A redelivery after BullMQ dropped the job id: the gate is closed by
      // now, and a match-any-word campaign would answer anything it sees.
      mockPrisma.automation.findMany.mockResolvedValue([
        { ...mockAutomation, id: "auto_any", dmTriggerEnabled: true, matchAnyWord: true },
      ]);
      await process({
        ...messageJob("leo@gmail.com", { messageId: "mid_dup" }),
        id: "redelivered_job",
      });

      expect(directTexts()).toEqual([
        "收到 leo@gmail.com ✅ 連結馬上傳給你！",
        LINK_TEXT,
      ]);
      expect(mockReserveWorkspaceDMSend).toHaveBeenCalledTimes(1);
    });

    it("counts a redelivered reply without an email only once", async () => {
      openGate();
      const process = getProcessor();

      await process(messageJob("hmm", { messageId: "mid_same" }));
      await process({ ...messageJob("hmm", { messageId: "mid_same" }), id: "again" });

      expect(contacts[0].pendingEmailAttempts).toBe(1);
      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    });

    it("delivers once when two email replies are handled at the same time", async () => {
      openGate();
      const process = getProcessor();

      await Promise.all([
        process(messageJob("first@gmail.com", { messageId: "mid_a" })),
        process(messageJob("second@gmail.com", { messageId: "mid_b" })),
      ]);

      expect(contacts[0].email).toBe("first@gmail.com");
      expect(directTexts()).toEqual([
        "收到 first@gmail.com ✅ 連結馬上傳給你！",
        LINK_TEXT,
      ]);
      expect(contacts[0].pendingEmailAutomationId).toBeNull();
    });

    it("keeps the email and the open gate when the link fails, and the retry does not thank twice", async () => {
      openGate();
      mockSendDirectMessage.mockImplementation(
        async (_token: string, _account: string, _user: string, text: string) => {
          if (text === LINK_TEXT) throw new RateLimitError("slow down");
          return { recipient_id: "commenter_999", message_id: "msg" };
        }
      );
      const process = getProcessor();

      await expect(process(messageJob("leo@gmail.com"))).rejects.toThrow("slow down");
      expect(contacts[0]).toMatchObject({
        email: "leo@gmail.com",
        pendingEmailAutomationId: "auto_789",
      });

      mockSendDirectMessage.mockResolvedValue({ recipient_id: "commenter_999", message_id: "msg" });
      await process({ ...messageJob("leo@gmail.com"), attemptsMade: 1 });

      expect(directTexts()).toEqual([
        "收到 leo@gmail.com ✅ 連結馬上傳給你！",
        LINK_TEXT,
        LINK_TEXT,
      ]);
      expect(contacts[0].pendingEmailAutomationId).toBeNull();
    });
  });

  describe("redeliveries, retries and limits", () => {
    // A stateful DmLog, so the keyword loop's `dm:<mid>` dedupe sees what an
    // earlier run of the same message wrote.
    function trackDmLogs() {
      const logs = new Map<string, Record<string, unknown>>();
      const key = (where: { automationId_commentId: { automationId: string; commentId: string } }) =>
        `${where.automationId_commentId.automationId}|${where.automationId_commentId.commentId}`;
      mockPrisma.dmLog.findUnique.mockImplementation(
        async ({ where }: { where: { automationId_commentId: { automationId: string; commentId: string } } }) =>
          logs.get(key(where)) ?? null
      );
      mockPrisma.dmLog.upsert.mockImplementation(
        async ({
          where,
          create,
          update,
        }: {
          where: { automationId_commentId: { automationId: string; commentId: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const row = logs.get(key(where));
          logs.set(key(where), row ? { ...row, ...update } : { ...create });
          return logs.get(key(where));
        }
      );
      return logs;
    }

    function revealClaimId(contact: FakeContact) {
      const gate = `${contact.pendingEmailAutomationId}:${contact.pendingEmailExpiresAt?.toISOString()}`;
      return createHash("sha256")
        .update(JSON.stringify(["email-reveal", contact.id, gate]))
        .digest("hex");
    }

    it("does not read a redelivered keyword trigger as the first answer to its own ask", async () => {
      trackDmLogs();
      mockPrisma.automation.findMany.mockResolvedValue([{ ...gated, dmTriggerEnabled: true }]);
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
      const process = getProcessor();

      await process(messageJob("LINK", { messageId: "mid_kw" }));
      await process({ ...messageJob("LINK", { messageId: "mid_kw" }), id: "redelivered" });

      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
      expect(contacts[0]).toMatchObject({
        pendingEmailAutomationId: "auto_789",
        pendingEmailAttempts: 0,
      });
    });

    it("keeps the gate open when the trigger is retried for another campaign that failed", async () => {
      const logs = trackDmLogs();
      const other = { ...mockAutomation, id: "auto_other", dmTriggerEnabled: true, collectEmail: false };
      mockPrisma.automation.findMany.mockResolvedValue([{ ...gated, dmTriggerEnabled: true }, other]);
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
      // The gated campaign's ask goes out first; the other campaign's link
      // send is the one that fails.
      mockSendDirectMessage
        .mockResolvedValueOnce({ recipient_id: "commenter_999", message_id: "ask_mid" })
        .mockRejectedValueOnce(new Error("socket hang up"));
      const process = getProcessor();

      await expect(process(messageJob("LINK", { messageId: "mid_two" }))).rejects.toThrow(
        "socket hang up"
      );
      await process({ ...messageJob("LINK", { messageId: "mid_two" }), attemptsMade: 1 });

      // The ask went out once and its gate survived; only the failed
      // campaign was retried.
      const asks = mockSendDirectMessage.mock.calls.filter(
        (call) => call[3] === defaultEmailPrompt(false)
      );
      expect(asks).toHaveLength(1);
      expect(contacts[0]).toMatchObject({
        pendingEmailAutomationId: "auto_789",
        pendingEmailAttempts: 0,
      });
      expect(
        directTexts().filter((text) => text !== defaultEmailPrompt(false))
      ).toEqual([LINK_TEXT, LINK_TEXT]);
      expect(logs.get("auto_other|dm:mid_two")).toMatchObject({ status: "SENT" });
    });

    it("does not let a match-any-word gated campaign re-open a silenced gate", async () => {
      const logs = trackDmLogs();
      mockPrisma.automation.findMany.mockResolvedValue([
        { ...gated, dmTriggerEnabled: true, matchAnyWord: true },
      ]);
      openGate({ pendingEmailAttempts: 3 });
      const process = getProcessor();

      await process(messageJob("nope", { messageId: "mid_4" }));
      await process(messageJob("still no", { messageId: "mid_5" }));

      expect(contacts[0]).toMatchObject({
        pendingEmailAutomationId: "auto_789",
        pendingEmailAttempts: 4,
        pendingEmailSilenced: true,
      });
      expect(mockSendDirectMessageWithEmailQuickReply).not.toHaveBeenCalled();
      expect(logs.get("auto_789|dm:mid_5")).toMatchObject({ status: "SKIPPED_DEDUP" });
    });

    it("hands later messages to the keyword campaigns once the link's send ended unconfirmed", async () => {
      const keywordCampaign = { ...mockAutomation, id: "auto_dm", dmTriggerEnabled: true, keywords: ["PRICE"] };
      mockPrisma.automation.findMany.mockResolvedValue([keywordCampaign]);
      openGate();
      // The link's send times out: Meta may have delivered it, so its claim
      // is kept and the job is not retried.
      mockSendDirectMessage.mockImplementation(
        async (_token: string, _account: string, _user: string, text: string) => {
          if (text === LINK_TEXT) throw new Error("socket hang up");
          return { recipient_id: "commenter_999", message_id: "msg" };
        }
      );
      const process = getProcessor();
      await expect(process(messageJob("leo@gmail.com", { messageId: "mid_1" }))).rejects.toThrow(
        "unconfirmed"
      );
      mockSendDirectMessage.mockResolvedValue({ recipient_id: "commenter_999", message_id: "msg" });
      expect(contacts[0].email).toBe("leo@gmail.com");

      // Meta redelivers the email message: still the gate's, nothing new.
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "PRICE" });
      await process({ ...messageJob("leo@gmail.com", { messageId: "mid_1" }), id: "again" });
      expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ automationId: "auto_dm" }) })
      );

      // A new message reaches the keyword campaigns instead of being eaten.
      await process(messageJob("PRICE?", { messageId: "mid_2" }));
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { automationId_commentId: { automationId: "auto_dm", commentId: "dm:mid_2" } },
          create: expect.objectContaining({ status: "SENT" }),
        })
      );
    });

    it("leaves the gate open while another attempt holds the link's claim, so its failure can retry", async () => {
      const contact = openGate();
      const reveal = revealClaimId(contact);
      claims.add(reveal);
      const process = getProcessor();

      // The racing message: the link is someone else's to send.
      await process(messageJob("second@gmail.com", { messageId: "mid_b" }));
      expect(contacts[0]).toMatchObject({ pendingEmailAutomationId: "auto_789" });
      expect(directTexts()).toEqual([]);

      // The attempt holding the claim was rejected outright and retries.
      claims.delete(reveal);
      await process({ ...messageJob("first@gmail.com", { messageId: "mid_a" }), attemptsMade: 1 });

      expect(directTexts()).toEqual([
        "收到 second@gmail.com ✅ 連結馬上傳給你！",
        LINK_TEXT,
      ]);
      expect(contacts[0].pendingEmailAutomationId).toBeNull();
    });

    it("sends no thanks and keeps the gate open when the monthly DM limit holds the link back", async () => {
      trackDmLogs();
      mockReserveWorkspaceDMSend.mockResolvedValueOnce({
        allowed: false,
        reserved: false,
        remaining: 0,
        limit: 100,
        periodStart: usagePeriodStart,
      });
      openGate();
      const process = getProcessor();

      await process(messageJob("leo@gmail.com", { messageId: "mid_1" }));
      expect(contacts[0]).toMatchObject({
        email: "leo@gmail.com",
        pendingEmailAutomationId: "auto_789",
      });
      expect(directTexts()).toEqual([]);
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { automationId_commentId: { automationId: "auto_789", commentId: "reveal:commenter_999" } },
          create: expect.objectContaining({ status: "SKIPPED_PLAN_LIMIT" }),
        })
      );

      // The limit has reset: their next message gets the thanks and the link.
      await process(messageJob("hello?", { messageId: "mid_2" }));
      expect(directTexts()).toEqual(["收到 leo@gmail.com ✅ 連結馬上傳給你！", LINK_TEXT]);
      expect(contacts[0].pendingEmailAutomationId).toBeNull();
    });
  });

  describe("campaigns without the gate", () => {
    it("keep an email typed into a DM out of the logs", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([
        { ...mockAutomation, dmTriggerEnabled: true, collectEmail: false },
      ]);
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });

      await getProcessor()(messageJob("LINK pls, me@example.com"));

      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ commentText: "(message with an email)" }),
        })
      );
    });

    it("send the link exactly as before and never look up an email", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([
        { ...gated, collectEmail: false },
      ]);
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });

      await getProcessor()(createMockJob());

      expect(mockSendPrivateReply).toHaveBeenCalledWith(
        "decrypted_token",
        "ig_456",
        "comment_555",
        LINK_TEXT
      );
      expect(mockPrisma.contact.findUnique).not.toHaveBeenCalled();
      // Only the bookkeeping row: matched people are listed as contacts.
      expect(contacts).toHaveLength(1);
      expect(contacts[0]).toMatchObject({
        username: "commenter_user",
        email: null,
        pendingEmailAutomationId: null,
      });
    });

    it("never fail a send because the contacts bookkeeping failed", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([
        { ...gated, collectEmail: false },
      ]);
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
      mockPrisma.contact.upsert.mockRejectedValue(new Error("contacts table locked"));

      await getProcessor()(createMockJob());

      expect(mockSendPrivateReply).toHaveBeenCalledWith(
        "decrypted_token",
        "ig_456",
        "comment_555",
        LINK_TEXT
      );
    });
  });

  describe("what brought each contact in", () => {
    it("records the matching comment, its post and keyword", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([{ ...gated, collectEmail: false }]);
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });

      await getProcessor()(createMockJob());

      expect(contacts[0]).toMatchObject({
        lastTriggerType: "comment",
        lastTriggerText: "I want the LINK!",
        lastTriggerMediaId: "media_101",
        lastTriggerKeyword: "LINK",
      });
      expect(contacts[0].lastTriggerAt).toBeInstanceOf(Date);
    });

    it("records a matching DM without its post, and never with an email in it", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([
        { ...mockAutomation, dmTriggerEnabled: true, collectEmail: false },
      ]);
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
      const process = getProcessor();

      await process(messageJob("LINK please", { messageId: "mid_a" }));
      expect(contacts[0]).toMatchObject({
        lastTriggerType: "dm",
        lastTriggerText: "LINK please",
        lastTriggerMediaId: null,
        lastTriggerKeyword: "LINK",
      });

      await process(messageJob("LINK pls, me@example.com", { messageId: "mid_b" }));
      expect(contacts[0].lastTriggerText).toBe("(message with an email)");
      expect(JSON.stringify(contacts)).not.toContain("me@example.com");
    });

    it("snapshots the comment that opened the gate as the email's source", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([gated]);
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
      const process = getProcessor();
      await process(createMockJob());

      // The email reply goes to the gate, never to the trigger bookkeeping.
      mockPrisma.automation.findMany.mockResolvedValue([]);
      await process(messageJob("leo@gmail.com"));

      expect(contacts[0]).toMatchObject({
        email: "leo@gmail.com",
        emailSourceType: "comment",
        emailSourceText: "I want the LINK!",
        emailSourceMediaId: "media_101",
        emailSourceKeyword: "LINK",
        lastTriggerText: "I want the LINK!",
      });
    });

    it("snapshots the DM keyword trigger as the email's source", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([{ ...gated, dmTriggerEnabled: true }]);
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
      const process = getProcessor();
      await process(messageJob("LINK", { messageId: "mid_kw" }));

      mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
      await process(messageJob("leo@gmail.com", { messageId: "mid_email" }));

      expect(contacts[0]).toMatchObject({
        email: "leo@gmail.com",
        emailSourceType: "dm",
        emailSourceText: "LINK",
        emailSourceMediaId: null,
        emailSourceKeyword: "LINK",
      });
    });
  });

  describe("profile enrichment", () => {
    it("reads the profile once the email is in, after the link went out", async () => {
      mockGetUserProfile.mockResolvedValue({
        name: "Leo 李",
        username: "other_name",
        followerCount: 1234,
        followsYou: true,
      });
      openGate();

      await getProcessor()(messageJob("leo@gmail.com"));

      expect(mockGetUserProfile).toHaveBeenCalledTimes(1);
      expect(mockGetUserProfile).toHaveBeenCalledWith("decrypted_token", "commenter_999");
      const linkCall = mockSendDirectMessage.mock.calls.findIndex((call) => call[3] === LINK_TEXT);
      expect(mockSendDirectMessage.mock.invocationCallOrder[linkCall]).toBeLessThan(
        mockGetUserProfile.mock.invocationCallOrder[0]
      );
      expect(contacts[0]).toMatchObject({
        name: "Leo 李",
        // The comment webhook's username is kept.
        username: "commenter_user",
        followerCount: 1234,
        followsYou: true,
        pendingEmailAutomationId: null,
      });
      expect(contacts[0].profileCheckedAt).toBeInstanceOf(Date);
    });

    it("never holds up or fails the delivery when the lookup fails", async () => {
      mockGetUserProfile.mockRejectedValue(new Error("graph down"));
      vi.spyOn(console, "log").mockImplementation(() => {});
      openGate();

      await getProcessor()(messageJob("leo@gmail.com"));

      expect(directTexts()).toEqual(["收到 leo@gmail.com ✅ 連結馬上傳給你！", LINK_TEXT]);
      expect(contacts[0]).toMatchObject({
        email: "leo@gmail.com",
        name: null,
        profileCheckedAt: null,
        pendingEmailAutomationId: null,
      });
    });

    it("still looks the profile up when the link could not be sent", async () => {
      mockGetUserProfile.mockResolvedValue({
        name: "Leo",
        username: null,
        followerCount: null,
        followsYou: null,
      });
      mockSendDirectMessage.mockImplementation(
        async (_token: string, _account: string, _user: string, text: string) => {
          if (text === LINK_TEXT) throw new RateLimitError("slow down");
          return { recipient_id: "commenter_999", message_id: "msg" };
        }
      );
      openGate();

      await expect(getProcessor()(messageJob("leo@gmail.com"))).rejects.toThrow("slow down");

      expect(contacts[0]).toMatchObject({ name: "Leo", pendingEmailAutomationId: "auto_789" });
    });

    it("records the follow gate's own check, but not an unknown answer", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([
        { ...gated, collectEmail: false, requireFollow: true },
      ]);
      mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
      mockGetUserFollowStatus.mockResolvedValue(false);
      const process = getProcessor();

      await process(createMockJob());
      expect(contacts[0]).toMatchObject({ followsYou: false });
      expect(contacts[0].profileCheckedAt).toBeInstanceOf(Date);

      mockGetUserFollowStatus.mockResolvedValue(null);
      await process(createMockJob({ ...mockJobData, commentId: "comment_556" }));
      expect(contacts[0].followsYou).toBe(false);
      // No extra profile lookups outside the email capture.
      expect(mockGetUserProfile).not.toHaveBeenCalled();
    });

    it("records a follow confirmed on a button tap", async () => {
      seedContact();
      mockPrisma.automation.findFirst.mockResolvedValue({
        ...gated,
        collectEmail: false,
        requireFollow: true,
      });
      mockGetUserFollowStatus.mockResolvedValue(true);

      await getProcessor()(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "followcheck:auto_789",
          mid: "tap_follow",
        })
      );

      expect(contacts[0].followsYou).toBe(true);
    });
  });

  describe("unsubscribing by DM", () => {
    const anyWord = {
      ...mockAutomation,
      id: "auto_any",
      dmTriggerEnabled: true,
      matchAnyWord: true,
      keywords: [],
    };

    beforeEach(() => {
      mockPrisma.instagramAccount.findUnique.mockResolvedValue({
        ...mockAutomation.instagramAccount,
        workspaceId: "workspace_123",
      });
      // A match-any-word campaign would answer every message handed on.
      mockPrisma.automation.findMany.mockResolvedValue([anyWord]);
    });

    it.each(["退訂", "  退訂！", "取消訂閱", "取消订阅", "退订 🙏", "Unsubscribe.", "STOP", "ｓｔｏｐ!!", "cancelar ❤️"])(
      "reads %j as an unsubscribe",
      (text) => {
        expect(isEmailOptOutMessage(text)).toBe(true);
      }
    );

    it.each(["please stop sending", "stop?? link", "退訂怎麼用", "", "stopp"])(
      "does not read %j as an unsubscribe",
      (text) => {
        expect(isEmailOptOutMessage(text)).toBe(false);
      }
    );

    it("opts out, confirms once, and keeps the keyword campaigns out of it", async () => {
      seedContact({ email: "leo@gmail.com", emailCapturedAt: new Date() });

      await getProcessor()(messageJob("退訂！", { messageId: "mid_stop" }));

      expect(contacts[0].emailOptedOutAt).toBeInstanceOf(Date);
      expect(directTexts()).toEqual([DEFAULT_EMAIL_OPT_OUT_MESSAGE]);
      expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
    });

    it("does not confirm twice when the message is redelivered", async () => {
      seedContact({ email: "leo@gmail.com", emailCapturedAt: new Date() });
      const process = getProcessor();

      await process(messageJob("stop", { messageId: "mid_stop" }));
      const optedOutAt = contacts[0].emailOptedOutAt;
      await process({ ...messageJob("stop", { messageId: "mid_stop" }), id: "redelivered" });
      await process({ ...messageJob("stop", { messageId: "mid_stop" }), attemptsMade: 1 });

      expect(directTexts()).toEqual([DEFAULT_EMAIL_OPT_OUT_MESSAGE]);
      expect(contacts[0].emailOptedOutAt).toBe(optedOutAt);
      expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
    });

    it("keeps the opt-out when the confirmation cannot be sent", async () => {
      seedContact({ email: "leo@gmail.com", emailCapturedAt: new Date() });
      mockSendDirectMessage.mockRejectedValue(new Error("socket hang up"));
      vi.spyOn(console, "log").mockImplementation(() => {});

      await getProcessor()(messageJob("unsubscribe"));

      expect(contacts[0].emailOptedOutAt).toBeInstanceOf(Date);
    });

    it("hands the message on unchanged to someone without an email", async () => {
      seedContact();

      await getProcessor()(messageJob("stop", { messageId: "mid_stop" }));

      expect(contacts[0].emailOptedOutAt).toBeNull();
      expect(directTexts()).not.toContain(DEFAULT_EMAIL_OPT_OUT_MESSAGE);
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { automationId_commentId: { automationId: "auto_any", commentId: "dm:mid_stop" } },
          create: expect.objectContaining({ status: "SENT" }),
        })
      );
    });

    it("lets a sentence that only mentions stopping reach the campaigns", async () => {
      seedContact({ email: "leo@gmail.com", emailCapturedAt: new Date() });

      await getProcessor()(messageJob("don't stop the giveaway!", { messageId: "mid_x" }));

      expect(contacts[0].emailOptedOutAt).toBeNull();
      expect(directTexts()).not.toContain(DEFAULT_EMAIL_OPT_OUT_MESSAGE);
    });
  });
});
