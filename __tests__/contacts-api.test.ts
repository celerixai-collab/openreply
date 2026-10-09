import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockContext } = vi.hoisted(() => ({
  mockPrisma: {
    contact: {
      findMany: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
  mockContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
// The real module pulls in next-auth; only the session lookup is replaced.
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));

import { DELETE, GET } from "../app/api/contacts/route";
import { GET as EXPORT } from "../app/api/contacts/export/route";
import { parseContactFilters, parsePagination } from "../lib/contacts/list";

const BOM = "﻿";

function request(path: string, method = "GET") {
  return new NextRequest(`https://open.example${path}`, { method });
}

const storedContact = {
  id: "contact_1",
  username: "leo",
  email: "leo@example.com",
  emailCapturedAt: new Date("2026-10-08T12:34:56.000Z"),
  emailSource: "quick_reply",
  emailConsentText: "想拿到連結前，先留下你的 Email 📩",
  emailSourceType: "comment",
  emailSourceText: "LINK",
  emailSourceMediaId: "media_1",
  emailSourceKeyword: "link",
  emailOptedOutAt: null,
  lastTriggerType: "dm",
  lastTriggerText: "hello",
  lastTriggerMediaId: null,
  lastTriggerKeyword: null,
  name: "Leo",
  followsYou: true,
  followerCount: 42,
  firstSeenAt: new Date("2026-10-08T12:00:00.000Z"),
  lastInteractionAt: new Date("2026-10-08T12:34:56.000Z"),
  emailAutomation: { id: "automation_1", name: "Free guide" },
  instagramAccount: { username: "creator" },
};

beforeEach(() => {
  vi.resetAllMocks();
  mockContext.mockResolvedValue({
    userId: "user_1",
    workspaceId: "workspace_1",
    role: "OWNER",
  });
  mockPrisma.contact.findMany.mockResolvedValue([storedContact]);
  mockPrisma.contact.count.mockResolvedValue(1);
  mockPrisma.contact.deleteMany.mockResolvedValue({ count: 1 });
});

describe("contact filters", () => {
  it("defaults to people with an email, page 1", () => {
    const params = new URLSearchParams();
    expect(parseContactFilters(params)).toEqual({ search: "", hasEmail: true });
    expect(parsePagination(params)).toEqual({ page: 1, limit: 25, skip: 0 });
  });

  it("strips a leading @ from the search and clamps paging", () => {
    const params = new URLSearchParams({
      search: "  @@leo ",
      hasEmail: "false",
      page: "-3",
      limit: "5000",
    });
    expect(parseContactFilters(params)).toEqual({ search: "leo", hasEmail: false });
    expect(parsePagination(params)).toEqual({ page: 1, limit: 100, skip: 0 });
    expect(parsePagination(new URLSearchParams({ page: "abc" })).page).toBe(1);
  });
});

describe("GET /api/contacts", () => {
  it("rejects a request without a session", async () => {
    mockContext.mockResolvedValue(null);
    const res = await GET(request("/api/contacts"));
    expect(res.status).toBe(401);
    expect(mockPrisma.contact.findMany).not.toHaveBeenCalled();
  });

  it("lists only the current workspace's contacts with an email, newest capture first", async () => {
    const res = await GET(request("/api/contacts"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(body.data.pagination).toEqual({ page: 1, limit: 25, total: 1, totalPages: 1 });
    const args = mockPrisma.contact.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ workspaceId: "workspace_1", email: { not: null } });
    expect(args.orderBy[0]).toEqual({ emailCapturedAt: { sort: "desc", nulls: "last" } });
    expect(mockPrisma.contact.count).toHaveBeenCalledWith({ where: args.where });
  });

  it("never selects the Instagram-scoped id or the pending gate state", async () => {
    await GET(request("/api/contacts"));
    const { select } = mockPrisma.contact.findMany.mock.calls[0][0];
    expect(select).not.toHaveProperty("igsid");
    expect(select).not.toHaveProperty("pendingEmailPrompt");
    expect(select).not.toHaveProperty("pendingEmailAutomationId");
  });

  it("exposes the profile, the email's source and the opt-out", async () => {
    await GET(request("/api/contacts"));
    const { select } = mockPrisma.contact.findMany.mock.calls[0][0];
    for (const field of [
      "name",
      "followsYou",
      "followerCount",
      "emailSourceType",
      "emailSourceText",
      "emailSourceMediaId",
      "emailSourceKeyword",
      "emailOptedOutAt",
    ]) {
      expect(select, field).toHaveProperty(field, true);
    }
  });

  it("searches username and email inside the workspace, and can include people without an email", async () => {
    await GET(request("/api/contacts?search=Leo&hasEmail=false&page=2&limit=10"));
    const args = mockPrisma.contact.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      workspaceId: "workspace_1",
      OR: [
        { username: { contains: "Leo", mode: "insensitive" } },
        { email: { contains: "Leo", mode: "insensitive" } },
      ],
    });
    expect(args.skip).toBe(10);
    expect(args.take).toBe(10);
  });
});

describe("DELETE /api/contacts", () => {
  it("deletes inside the current workspace only", async () => {
    const res = await DELETE(request("/api/contacts?id=contact_1", "DELETE"));
    expect(res.status).toBe(200);
    expect(mockPrisma.contact.deleteMany).toHaveBeenCalledWith({
      where: { id: "contact_1", workspaceId: "workspace_1" },
    });
  });

  it("reads another workspace's contact as not found", async () => {
    mockPrisma.contact.deleteMany.mockResolvedValue({ count: 0 });
    const res = await DELETE(request("/api/contacts?id=someone_elses", "DELETE"));
    expect(res.status).toBe(404);
  });

  it("requires an owner or admin, a session and an id", async () => {
    mockContext.mockResolvedValueOnce({ userId: "u", workspaceId: "workspace_1", role: "MEMBER" });
    expect((await DELETE(request("/api/contacts?id=contact_1", "DELETE"))).status).toBe(403);
    mockContext.mockResolvedValueOnce(null);
    expect((await DELETE(request("/api/contacts?id=contact_1", "DELETE"))).status).toBe(401);
    expect((await DELETE(request("/api/contacts", "DELETE"))).status).toBe(400);
    expect(mockPrisma.contact.deleteMany).not.toHaveBeenCalled();
  });
});

describe("contact filters by campaign", () => {
  it("narrows to one campaign's emails, still inside the workspace", async () => {
    await GET(request("/api/contacts?campaign=automation_1"));
    expect(mockPrisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace_1",
          emailAutomationId: "automation_1",
        }),
      })
    );
  });

  it("ignores a campaign value that is not an id", () => {
    expect(
      parseContactFilters(new URLSearchParams({ campaign: "x' OR 1=1" }))
    ).toEqual({ search: "", hasEmail: true });
  });
});

describe("GET /api/contacts/export", () => {
  it("is limited to owners and admins", async () => {
    mockContext.mockResolvedValue({
      userId: "user_2",
      workspaceId: "workspace_1",
      role: "MEMBER",
    });
    const res = await EXPORT(request("/api/contacts/export"));
    expect(res.status).toBe(403);
    expect(mockPrisma.contact.findMany).not.toHaveBeenCalled();
  });

  it("tells the page whether the viewer may export and delete", async () => {
    const owner = await (await GET(request("/api/contacts"))).json();
    expect(owner.data.canManage).toBe(true);
    mockContext.mockResolvedValue({
      userId: "user_2",
      workspaceId: "workspace_1",
      role: "MEMBER",
    });
    const member = await (await GET(request("/api/contacts"))).json();
    expect(member.data.canManage).toBe(false);
    expect(member.data.contacts).toHaveLength(1);
  });

  it("rejects a request without a session", async () => {
    mockContext.mockResolvedValue(null);
    const res = await EXPORT(request("/api/contacts/export"));
    expect(res.status).toBe(401);
    expect(mockPrisma.contact.findMany).not.toHaveBeenCalled();
  });

  it("returns a UTF-8 CSV download with BOM, CRLF and every field quoted", async () => {
    const res = await EXPORT(request("/api/contacts/export"));
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="openreply-contacts-\d{4}-\d{2}-\d{2}\.csv"$/
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    // Read the raw bytes: Response.text() would strip the BOM.
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      await res.arrayBuffer()
    );
    expect(text.startsWith(BOM)).toBe(true);
    expect(text.slice(1).split("\r\n")).toEqual([
      '"username","email","captured_at","campaign","instagram_account","email_source","consent_text","name","follows_you","follower_count","source_type","source_text","source_media_id","source_keyword","opted_out_at"',
      '"leo","leo@example.com","2026-10-08T12:34:56.000Z","Free guide","creator","quick_reply","想拿到連結前，先留下你的 Email 📩","Leo","true","42","comment","LINK","media_1","link",""',
      "",
    ]);
    expect(text).not.toContain("igsid");
  });

  it("uses the page's filters inside the current workspace", async () => {
    await EXPORT(request("/api/contacts/export?search=leo&hasEmail=false"));
    const args = mockPrisma.contact.findMany.mock.calls[0][0];
    expect(args.where.workspaceId).toBe("workspace_1");
    expect(args.where).not.toHaveProperty("email");
    expect(args.where.OR).toHaveLength(2);
    expect(args).not.toHaveProperty("take");
  });

  it("guards cells a spreadsheet would run as a formula", async () => {
    mockPrisma.contact.findMany.mockResolvedValue([
      {
        ...storedContact,
        username: "=HYPERLINK(\"http://x\")",
        emailAutomation: { id: "a", name: " +SUM(1)" },
        emailConsentText: "＝cmd",
      },
    ]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      await (await EXPORT(request("/api/contacts/export"))).arrayBuffer()
    );
    const row = text.split("\r\n")[1];
    expect(row).toContain('"\'=HYPERLINK(""http://x"")"');
    expect(row).toContain('"\' +SUM(1)"');
    expect(row).toContain('"\'＝cmd"');
  });

  it("leaves empty cells for a contact whose campaign was deleted", async () => {
    mockPrisma.contact.findMany.mockResolvedValue([
      { ...storedContact, emailAutomation: null, emailSource: null },
    ]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      await (await EXPORT(request("/api/contacts/export"))).arrayBuffer()
    );
    expect(text.split("\r\n")[1]).toBe(
      '"leo","leo@example.com","2026-10-08T12:34:56.000Z","","creator","","想拿到連結前，先留下你的 Email 📩","Leo","true","42","comment","LINK","media_1","link",""'
    );
  });

  it("shows what someone without an email last sent, and an opt-out date", async () => {
    mockPrisma.contact.findMany.mockResolvedValue([
      {
        ...storedContact,
        email: null,
        emailCapturedAt: null,
        emailOptedOutAt: new Date("2026-10-09T01:02:03.000Z"),
        followsYou: null,
        followerCount: null,
      },
    ]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      await (await EXPORT(request("/api/contacts/export?hasEmail=false"))).arrayBuffer()
    );
    expect(text.split("\r\n")[1]).toMatch(
      /,"Leo","","","dm","hello","","","2026-10-09T01:02:03\.000Z"$/
    );
  });
});
