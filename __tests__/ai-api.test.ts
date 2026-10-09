import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockContext, mockHealth, mockSend, mockDismiss } = vi.hoisted(() => ({
  mockPrisma: {
    aiDraft: {
      updateMany: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    instagramAccount: { findMany: vi.fn(), findFirst: vi.fn() },
    aiAssistant: { upsert: vi.fn() },
  },
  mockContext: vi.fn(),
  mockHealth: vi.fn(),
  mockSend: vi.fn(),
  mockDismiss: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));
vi.mock("@/lib/ops/worker-health", () => ({ getWorkerHealth: mockHealth }));
vi.mock("@/lib/ai/drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/drafts")>()),
  requestDraftSend: mockSend,
  dismissDraft: mockDismiss,
}));

import { GET as LIST } from "../app/api/ai/drafts/route";
import { POST as SEND } from "../app/api/ai/drafts/[id]/send/route";
import { POST as DISMISS } from "../app/api/ai/drafts/[id]/dismiss/route";
import { GET as GET_SETTINGS, PATCH } from "../app/api/ai/settings/route";
import { parseDraftQuery } from "../lib/ai/drafts";
import { createI18n } from "../lib/i18n";

function req(path: string, method = "GET", body?: unknown) {
  return new NextRequest(`https://open.example${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}
const params = { params: Promise.resolve({ id: "draft_1" }) };
const as = (role: string) =>
  mockContext.mockResolvedValue({ userId: "u1", workspaceId: "ws_1", role });

beforeEach(() => {
  vi.resetAllMocks();
  as("OWNER");
  mockPrisma.aiDraft.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.aiDraft.findMany.mockResolvedValue([]);
  mockPrisma.aiDraft.count.mockResolvedValue(0);
  mockPrisma.aiDraft.groupBy.mockResolvedValue([]);
  mockPrisma.instagramAccount.findMany.mockResolvedValue([
    { id: "acct_1", username: "leo", provider: "META", aiAssistant: null },
  ]);
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "acct_1", provider: "META" });
  mockPrisma.aiAssistant.upsert.mockImplementation(async ({ create }) => create);
  mockHealth.mockResolvedValue({ healthy: true, heartbeat: { aiConfigured: true }, ageMs: 1000 });
  mockSend.mockResolvedValue({ ok: true, status: "SENDING" });
  mockDismiss.mockResolvedValue(true);
});

describe("draft list", () => {
  it("requires a session", async () => {
    mockContext.mockResolvedValue(null);
    expect((await LIST(req("/api/ai/drafts"))).status).toBe(401);
  });

  it("lets members view, scoped to the workspace, and expires stale drafts first", async () => {
    as("MEMBER");
    const res = await LIST(req("/api/ai/drafts?view=history&status=sent"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.canManage).toBe(false);
    expect(mockPrisma.aiDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "ws_1", status: "PENDING" }),
        data: expect.objectContaining({ status: "EXPIRED" }),
      })
    );
    expect(mockPrisma.aiDraft.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: "ws_1",
      status: { in: ["SENT"] },
    });
  });

  it("never returns the Instagram-scoped id", async () => {
    // The second findMany is the "already got an AI reply" lookup: nobody has.
    mockPrisma.aiDraft.findMany.mockImplementation(async ({ where }) => where.status === "SENT" ? [] : [
      {
        id: "d1",
        instagramAccountId: "acct_1",
        igsid: "fan_secret_id",
        username: null,
        inboundAt: new Date("2026-10-09T10:00:00Z"),
        contact: { name: "Fan", username: "fan.one" },
        instagramAccount: { username: "leo", aiAssistant: { disclosureText: "（AI）" } },
      },
    ]);
    const body = await (await LIST(req("/api/ai/drafts"))).json();
    expect(JSON.stringify(body)).not.toContain("fan_secret_id");
    expect(body.data.drafts[0]).toMatchObject({
      username: "fan.one",
      firstReply: true,
      windowEndsAt: "2026-10-10T10:00:00.000Z",
      disclosureText: "（AI）",
    });
  });

  it("parses views, statuses and paging defensively", () => {
    expect(parseDraftQuery(new URLSearchParams()).statuses).toEqual(["PENDING", "SENDING"]);
    expect(parseDraftQuery(new URLSearchParams("view=history&status=PENDING")).statuses).not.toContain("PENDING");
    expect(parseDraftQuery(new URLSearchParams("page=-2&limit=999"))).toMatchObject({ page: 1, limit: 50 });
  });
});

describe("send and dismiss", () => {
  it("are owner/admin only", async () => {
    as("MEMBER");
    expect((await SEND(req("/api/ai/drafts/draft_1/send", "POST", { text: "hi" }), params)).status).toBe(403);
    expect((await DISMISS(req("/api/ai/drafts/draft_1/dismiss", "POST"), params)).status).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it("require a session", async () => {
    mockContext.mockResolvedValue(null);
    expect((await SEND(req("/api/ai/drafts/draft_1/send", "POST", { text: "hi" }), params)).status).toBe(401);
  });

  it("passes the workspace and text through and maps failures to statuses", async () => {
    as("ADMIN");
    const ok = await SEND(req("/api/ai/drafts/draft_1/send", "POST", { text: "hi" }), params);
    expect(ok.status).toBe(202);
    expect(mockSend).toHaveBeenCalledWith({ workspaceId: "ws_1", draftId: "draft_1", text: "hi" });

    mockSend.mockResolvedValue({ ok: false, httpStatus: 410, code: "window_closed", error: "closed" });
    const closed = await SEND(req("/api/ai/drafts/draft_1/send", "POST", { text: "hi" }), params);
    expect(closed.status).toBe(410);
    expect((await closed.json()).code).toBe("window_closed");
  });

  it("reports a dismiss of an already decided draft", async () => {
    mockDismiss.mockResolvedValue(false);
    expect((await DISMISS(req("/api/ai/drafts/draft_1/dismiss", "POST"), params)).status).toBe(409);
  });
});

describe("settings", () => {
  it("shows members the settings and the worker's key status, never a key", async () => {
    as("MEMBER");
    const body = await (await GET_SETTINGS(req("/api/ai/settings"))).json();
    expect(body.data).toMatchObject({
      selectedAccountId: "acct_1",
      supported: true,
      canManage: false,
      worker: { healthy: true, aiConfigured: true },
      settings: { enabled: false, model: "claude-haiku-5-5", mode: "draft", dailyDraftCapPerPerson: 10 },
    });
    expect(body.data.settings.disclosureText).toBe("（我是 AI 小助理，訊息經過本人確認後送出）");
  });

  it("reports an unknown key status for a worker that predates the assistant", async () => {
    mockHealth.mockResolvedValue({ healthy: true, heartbeat: { status: "running" }, ageMs: 1 });
    const body = await (await GET_SETTINGS(req("/api/ai/settings"))).json();
    expect(body.data.worker.aiConfigured).toBeNull();
  });

  it("only lets owners and admins change them", async () => {
    as("MEMBER");
    expect((await PATCH(req("/api/ai/settings", "PATCH", { accountId: "acct_1", enabled: true }))).status).toBe(403);
    expect(mockPrisma.aiAssistant.upsert).not.toHaveBeenCalled();
  });

  it("saves draft mode on Haiku 5.5, whatever the request says", async () => {
    const res = await PATCH(
      req("/api/ai/settings", "PATCH", { accountId: "acct_1", enabled: true, knowledge: "  課程 NT$1,200  ", dailyDraftCapPerPerson: 5 })
    );
    expect(res.status).toBe(200);
    expect(mockPrisma.aiAssistant.upsert.mock.calls[0][0]).toMatchObject({
      where: { instagramAccountId: "acct_1" },
      create: { workspaceId: "ws_1", mode: "draft", model: "claude-haiku-5-5", enabled: true, knowledge: "課程 NT$1,200", dailyDraftCapPerPerson: 5 },
      update: { enabled: true, knowledge: "課程 NT$1,200", dailyDraftCapPerPerson: 5 },
    });

    expect((await PATCH(req("/api/ai/settings", "PATCH", { accountId: "acct_1", model: "claude-opus-5-5" }))).status).toBe(400);
    expect((await PATCH(req("/api/ai/settings", "PATCH", { accountId: "acct_1", dailyDraftCapPerPerson: 0 }))).status).toBe(400);
  });

  it("refuses Zernio accounts and accounts of other workspaces", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValueOnce({ id: "acct_1", provider: "ZERNIO" });
    expect((await PATCH(req("/api/ai/settings", "PATCH", { accountId: "acct_1", enabled: true }))).status).toBe(400);

    mockPrisma.instagramAccount.findFirst.mockResolvedValueOnce(null);
    expect((await PATCH(req("/api/ai/settings", "PATCH", { accountId: "other", enabled: true }))).status).toBe(404);
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: "other", workspaceId: "ws_1" } })
    );
  });
});

describe("AI assistant interface copy", () => {
  it("uses the agreed Taiwanese labels", () => {
    const { t } = createI18n("zh-TW");
    expect(t("AI Assistant")).toBe("AI 助理");
    expect(t("Drafts")).toBe("草稿");
    expect(t("Settings")).toBe("設定");
    expect(t("Send reply")).toBe("送出");
    expect(t("Don't reply")).toBe("不回");
    expect(t("Suggest replying personally")).toBe("建議親自回覆");
    expect(t("AI key not set")).toBe("尚未設定 AI 金鑰");
  });
});
