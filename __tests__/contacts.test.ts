import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    contact: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    postbackDelivery: { create: vi.fn(), findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  EMAIL_GATE_TTL_MS,
  claimOnce,
  clearEmailGate,
  findKnownEmail,
  openEmailGate,
  recordContactInteraction,
  recordFailedEmailAttempt,
  storeCapturedEmail,
} from "../lib/contacts/contacts";
import type { Contact } from "@/app/generated/prisma/client";

const expiresAt = new Date("2026-10-16T08:00:00.000Z");
const openContact = {
  id: "contact_1",
  workspaceId: "workspace_1",
  instagramAccountId: "account_1",
  igsid: "person_1",
  username: "leo.tw",
  email: null,
  emailCapturedAt: null,
  emailAutomationId: null,
  emailSource: null,
  emailConsentText: null,
  pendingEmailAutomationId: "campaign_1",
  pendingEmailPrompt: "the ask",
  pendingEmailAttempts: 3,
  pendingEmailExpiresAt: expiresAt,
  pendingEmailSilenced: false,
  firstSeenAt: new Date(),
  lastInteractionAt: new Date(),
  updatedAt: new Date(),
} satisfies Contact;

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.contact.upsert.mockResolvedValue({});
  mockPrisma.contact.updateMany.mockResolvedValue({ count: 1 });
});

describe("recordContactInteraction", () => {
  it("keeps a known username when a DM job has none", async () => {
    await recordContactInteraction({
      workspaceId: "workspace_1",
      instagramAccountId: "account_1",
      igsid: "person_1",
    });

    const args = mockPrisma.contact.upsert.mock.calls[0][0];
    expect(args.where).toEqual({
      instagramAccountId_igsid: { instagramAccountId: "account_1", igsid: "person_1" },
    });
    expect(args.update).not.toHaveProperty("username");
    expect(args.update.lastInteractionAt).toBeInstanceOf(Date);
    expect(args.create).toMatchObject({ workspaceId: "workspace_1", username: null });
  });

  it("never throws, so it cannot block the DM it accompanies", async () => {
    mockPrisma.contact.upsert.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordContactInteraction({
        workspaceId: "workspace_1",
        instagramAccountId: "account_1",
        igsid: "person_1",
        username: "leo.tw",
      })
    ).resolves.toBeUndefined();
  });
});

describe("email gate state", () => {
  it("opens a gate for seven days with the exact ask as its prompt", async () => {
    const before = Date.now();
    await openEmailGate({
      workspaceId: "workspace_1",
      instagramAccountId: "account_1",
      igsid: "person_1",
      username: "leo.tw",
      automationId: "campaign_1",
      prompt: "the ask",
    });

    const { update } = mockPrisma.contact.upsert.mock.calls[0][0];
    expect(update).toMatchObject({
      username: "leo.tw",
      pendingEmailAutomationId: "campaign_1",
      pendingEmailPrompt: "the ask",
      pendingEmailAttempts: 0,
      pendingEmailSilenced: false,
    });
    expect(update.pendingEmailExpiresAt.getTime()).toBeGreaterThanOrEqual(
      before + EMAIL_GATE_TTL_MS
    );
  });

  it("propagates a failed gate write: gate state is essential", async () => {
    mockPrisma.contact.upsert.mockRejectedValue(new Error("db down"));
    await expect(
      openEmailGate({
        workspaceId: "workspace_1",
        instagramAccountId: "account_1",
        igsid: "person_1",
        automationId: "campaign_1",
        prompt: "the ask",
      })
    ).rejects.toThrow("db down");
  });

  it("stores an email only on the gate as it was read, and only once", async () => {
    expect(
      await storeCapturedEmail(openContact, { email: "leo@gmail.com", source: "typed" })
    ).toBe(true);
    expect(mockPrisma.contact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "contact_1",
        pendingEmailAutomationId: "campaign_1",
        pendingEmailExpiresAt: expiresAt,
        email: null,
      },
      data: expect.objectContaining({
        email: "leo@gmail.com",
        emailSource: "typed",
        emailAutomationId: "campaign_1",
        emailConsentText: "the ask",
        emailCapturedAt: expect.any(Date),
      }),
    });

    mockPrisma.contact.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await storeCapturedEmail(openContact, { email: "other@gmail.com", source: "typed" })
    ).toBe(false);
  });

  it("silences the gate on the reply after the third re-prompt", async () => {
    expect(await recordFailedEmailAttempt(openContact)).toEqual({
      attempts: 4,
      silenced: true,
    });
    expect(mockPrisma.contact.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        pendingEmailAttempts: 3,
        pendingEmailSilenced: false,
        pendingEmailExpiresAt: expiresAt,
      }),
      data: expect.objectContaining({ pendingEmailAttempts: 4, pendingEmailSilenced: true }),
    });
    expect(
      await recordFailedEmailAttempt({ ...openContact, pendingEmailAttempts: 1 })
    ).toEqual({ attempts: 2, silenced: false });

    mockPrisma.contact.updateMany.mockResolvedValue({ count: 0 });
    expect(await recordFailedEmailAttempt(openContact)).toBeNull();
  });

  it("clears only the gate it read, never a newer one", async () => {
    await clearEmailGate(openContact);
    expect(mockPrisma.contact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "contact_1",
        pendingEmailAutomationId: "campaign_1",
        pendingEmailExpiresAt: expiresAt,
      },
      data: {
        pendingEmailAutomationId: null,
        pendingEmailPrompt: null,
        pendingEmailAttempts: 0,
        pendingEmailExpiresAt: null,
        pendingEmailSilenced: false,
      },
    });
  });

  it("reads the known email by account and person", async () => {
    mockPrisma.contact.findUnique.mockResolvedValue({ email: "leo@gmail.com" });
    expect(await findKnownEmail("account_1", "person_1")).toBe("leo@gmail.com");
    mockPrisma.contact.findUnique.mockResolvedValue(null);
    expect(await findKnownEmail("account_1", "person_2")).toBeNull();
  });
});

describe("claimOnce", () => {
  it("claims an id exactly once and rethrows anything but a duplicate", async () => {
    mockPrisma.postbackDelivery.create
      .mockResolvedValueOnce({ id: "x" })
      .mockRejectedValueOnce({ code: "P2002" })
      .mockRejectedValueOnce(new Error("db down"));

    expect(await claimOnce("x")).toBe(true);
    expect(await claimOnce("x")).toBe(false);
    await expect(claimOnce("x")).rejects.toThrow("db down");
  });
});
