import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma } = vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = "test-app-secret";
  return {
  mockPrisma: {
    trackedLink: { findUnique: vi.fn(), findMany: vi.fn() },
    linkClick: { create: vi.fn(), findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    contact: { findFirst: vi.fn() },
  },
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { GET as REDIRECT } from "../app/r/[slug]/route";
import { GET as WHO } from "../app/api/waitlist-ref/route";
import { DEFAULT_CLICK_SALT, hashRecipientId, hashRecipientIdWith } from "@/lib/tracking/server";
import { checkWaitlistTaps, withWaitlistRef } from "@/lib/tracking/waitlist-ref";

const WAITLIST = "https://leo-waitlist.vercel.app/studio/";
const token = hashRecipientId("igsid_amy");

function link(destinationUrl: string) {
  return {
    id: "link_1",
    workspaceId: "ws_1",
    automationId: "auto_1",
    destinationUrl,
    automation: { instagramAccountId: "acct_1", name: "剪輯室 早鳥等候 A" },
  };
}

async function redirect(destinationUrl: string, query: string) {
  mockPrisma.trackedLink.findUnique.mockResolvedValue(link(destinationUrl));
  const response = await REDIRECT(
    new Request(`https://open.example/r/abc123${query}`) as Parameters<typeof REDIRECT>[0],
    { params: Promise.resolve({ slug: "abc123" }) }
  );
  return response.headers.get("location");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.linkClick.create.mockResolvedValue({});
  mockPrisma.dmLog.findMany.mockResolvedValue([
    { commenterId: "igsid_bob", commenterName: "bob" },
    { commenterId: "igsid_amy", commenterName: "amy.edits" },
  ]);
  mockPrisma.contact.findFirst.mockResolvedValue(null);
});

describe("waitlist links", () => {
  it("carry the slug and recipient token only to the waitlist site", async () => {
    expect(await redirect(WAITLIST, `?r=${token}`)).toBe(
      `${WAITLIST}?or_s=abc123&or_r=${token}`
    );
    // other campaigns' links are untouched, with or without a token
    expect(await redirect("https://example.com/offer", `?r=${token}`)).toBe("https://example.com/offer");
    // without a token the campaign is still known from the link
    expect(await redirect(WAITLIST, "")).toBe(`${WAITLIST}?or_s=abc123`);
    expect(withWaitlistRef("https://leo-waitlist.vercel.app.evil.com/", "s", token)).toBe(
      "https://leo-waitlist.vercel.app.evil.com/"
    );
  });

  it("keeps the link's own query string", async () => {
    expect(await redirect(`${WAITLIST}?utm_medium=ig&utm_content=post_c`, `?r=${token}`)).toBe(
      `${WAITLIST}?utm_medium=ig&utm_content=post_c&or_s=abc123&or_r=${token}`
    );
  });
});

describe("waitlist ref lookup", () => {
  const who = (query: string, origin = "https://leo-waitlist.vercel.app") =>
    WHO(new NextRequest(`https://open.example/api/waitlist-ref${query}`, { headers: { origin } }));

  it("returns the username and campaign of the person the link was sent to", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue(link(WAITLIST));
    const response = await who(`?s=abc123&r=${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://leo-waitlist.vercel.app");
    expect(await response.json()).toEqual({ ok: true, username: "amy.edits", campaign: "剪輯室 早鳥等候 A" });
  });

  it("falls back to the contact's username", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue(link(WAITLIST));
    mockPrisma.dmLog.findMany.mockResolvedValue([{ commenterId: "igsid_amy", commenterName: null }]);
    mockPrisma.contact.findFirst.mockResolvedValue({ username: "@amy.edits" });
    expect(await (await who(`?s=abc123&r=${token}`)).json()).toMatchObject({ username: "amy.edits" });
  });

  it("matches tokens made by a host without NEXTAUTH_SECRET (the worker)", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue(link(WAITLIST));
    const workerToken = hashRecipientIdWith(DEFAULT_CLICK_SALT, "igsid_amy");
    expect(await (await who(`?s=abc123&r=${workerToken}`)).json()).toMatchObject({ username: "amy.edits" });
  });

  it("matches tokens made with the worker's own secret", async () => {
    process.env.WORKER_NEXTAUTH_SECRET = "railway-secret";
    try {
      mockPrisma.trackedLink.findUnique.mockResolvedValue(link(WAITLIST));
      const workerToken = hashRecipientIdWith("railway-secret", "igsid_amy");
      expect(await (await who(`?s=abc123&r=${workerToken}`)).json()).toMatchObject({ username: "amy.edits" });
    } finally {
      delete process.env.WORKER_NEXTAUTH_SECRET;
    }
  });

  it("still returns the campaign when the person is unknown or there is no token", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue(link(WAITLIST));
    for (const query of [`?s=abc123&r=${hashRecipientId("igsid_stranger")}`, "?s=abc123", "?s=abc123&r=short"]) {
      const response = await who(query);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, campaign: "剪輯室 早鳥等候 A", username: null });
    }
  });

  it("answers nothing for other campaigns' links and bad input", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue(link("https://example.com/offer"));
    expect((await who(`?s=abc123&r=${token}`)).status).toBe(404);
    expect(mockPrisma.dmLog.findMany).not.toHaveBeenCalled();
    expect((await who("?s=bad%20slug!")).status).toBe(400);

    mockPrisma.trackedLink.findUnique.mockResolvedValue(link(WAITLIST));
    const other = await who(`?s=abc123&r=${token}`, "https://evil.example");
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("waitlist tap check", () => {
  it("counts recent taps on waitlist links and which ones matched a person", async () => {
    mockPrisma.trackedLink.findMany.mockResolvedValue([
      { id: "link_1", destinationUrl: WAITLIST, automationId: "auto_1", automation: { name: "A" } },
      { id: "link_2", destinationUrl: "https://example.com/", automationId: "auto_2", automation: { name: "Other" } },
    ]);
    mockPrisma.linkClick.findMany.mockResolvedValue([
      { trackedLinkId: "link_1", recipientHash: token, createdAt: new Date() },
      { trackedLinkId: "link_1", recipientHash: hashRecipientIdWith(DEFAULT_CLICK_SALT, "igsid_bob"), createdAt: new Date() },
      { trackedLinkId: "link_1", recipientHash: null, createdAt: new Date() },
    ]);
    const result = await checkWaitlistTaps("ws_1", new Date(0));
    expect(mockPrisma.linkClick.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ trackedLinkId: { in: ["link_1"] } }) })
    );
    expect(result).toMatchObject({ total: 3, withToken: 2, matchedApp: 1, matchedDefault: 1 });
    expect(result.taps.map((t) => t.username)).toEqual(["amy.edits", "bob", null]);
  });
});
