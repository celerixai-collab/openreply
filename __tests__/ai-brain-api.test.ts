import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockContext, mockQueueAdd, store } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    mockPrisma: {
      instagramAccount: { findFirst: vi.fn() },
      aiKnowledgeEntry: {
        findMany: vi.fn(),
        count: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      aiLink: {
        findMany: vi.fn(),
        count: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      aiDraft: { findMany: vi.fn() },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    },
    mockContext: vi.fn(),
    mockQueueAdd: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => ({
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    incr: vi.fn(async (key: string) => {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      return next;
    }),
    expire: vi.fn(async () => 1),
  }),
}));
vi.mock("@/lib/ai/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/queue")>()),
  getAiQueue: () => ({ add: mockQueueAdd }),
}));

import { GET as GET_BRAIN } from "../app/api/ai/brain/route";
import { POST as ADD_ENTRY, PATCH as EDIT_ENTRY, DELETE as DELETE_ENTRY } from "../app/api/ai/brain/entries/route";
import { POST as ADD_LINK } from "../app/api/ai/brain/links/route";
import { POST as PLAY, GET as POLL } from "../app/api/ai/playground/route";
import { GET as GAPS } from "../app/api/ai/gaps/route";

function req(path: string, method = "GET", body?: unknown) {
  return new NextRequest(`https://open.example${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}
const as = (role: string) => mockContext.mockResolvedValue({ userId: "u1", workspaceId: "ws_1", role });

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  as("OWNER");
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "acct_1", provider: "META" });
  mockPrisma.aiKnowledgeEntry.findMany.mockResolvedValue([]);
  mockPrisma.aiLink.findMany.mockResolvedValue([]);
  mockPrisma.aiKnowledgeEntry.count.mockResolvedValue(0);
  mockPrisma.aiLink.count.mockResolvedValue(0);
  mockPrisma.aiKnowledgeEntry.findFirst.mockResolvedValue(null);
  mockPrisma.aiLink.findFirst.mockResolvedValue(null);
  mockPrisma.aiKnowledgeEntry.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ id: "e1", ...args.data }));
  mockPrisma.aiLink.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ id: "l1", ...args.data }));
  mockQueueAdd.mockResolvedValue({});
});

describe("second brain API", () => {
  it("lists entries and links for an account of the workspace", async () => {
    const res = await GET_BRAIN(req("/api/ai/brain?accountId=acct_1"));
    expect(res.status).toBe(200);
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "acct_1", workspaceId: "ws_1" } })
    );
  });

  it("refuses another workspace's account and members who cannot manage", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(null);
    expect((await GET_BRAIN(req("/api/ai/brain?accountId=other"))).status).toBe(404);
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "acct_1", provider: "META" });
    as("MEMBER");
    expect(
      (await ADD_ENTRY(req("/api/ai/brain/entries", "POST", { accountId: "acct_1", title: "a", content: "b" }))).status
    ).toBe(403);
  });

  it("adds several entries at once, after the last position", async () => {
    mockPrisma.aiKnowledgeEntry.findFirst.mockResolvedValue({ position: 4 });
    const res = await ADD_ENTRY(
      req("/api/ai/brain/entries", "POST", {
        accountId: "acct_1",
        entries: [
          { title: " 價格 ", content: "10/28 公布" },
          { title: "適合誰", content: "口說型創作者" },
        ],
      })
    );
    expect(res.status).toBe(201);
    expect(mockPrisma.aiKnowledgeEntry.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ title: "價格", position: 5, workspaceId: "ws_1" }) })
    );
    expect(mockPrisma.aiKnowledgeEntry.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ position: 6 }) })
    );
  });

  it("rejects empty entries and too many entries", async () => {
    const empty = await ADD_ENTRY(req("/api/ai/brain/entries", "POST", { accountId: "acct_1", title: "", content: "x" }));
    expect(empty.status).toBe(400);
    mockPrisma.aiKnowledgeEntry.count.mockResolvedValue(100);
    const full = await ADD_ENTRY(req("/api/ai/brain/entries", "POST", { accountId: "acct_1", title: "a", content: "b" }));
    expect(full.status).toBe(400);
  });

  it("only edits and deletes entries of the signed-in workspace", async () => {
    mockPrisma.aiKnowledgeEntry.findUnique.mockResolvedValue({ id: "e1", instagramAccountId: "acct_x" });
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(null);
    expect((await EDIT_ENTRY(req("/api/ai/brain/entries?id=e1", "PATCH", { enabled: false }))).status).toBe(404);
    expect((await DELETE_ENTRY(req("/api/ai/brain/entries?id=e1", "DELETE"))).status).toBe(404);
    expect(mockPrisma.aiKnowledgeEntry.update).not.toHaveBeenCalled();
    expect(mockPrisma.aiKnowledgeEntry.delete).not.toHaveBeenCalled();
  });

  it("accepts only https links with a short button title", async () => {
    const http = await ADD_LINK(
      req("/api/ai/brain/links", "POST", { accountId: "acct_1", label: "名單", url: "http://example.com" })
    );
    expect(http.status).toBe(400);
    const long = await ADD_LINK(
      req("/api/ai/brain/links", "POST", { accountId: "acct_1", label: "這是一個超過二十個字的按鈕標題一二三四五六", url: "https://example.com" })
    );
    expect(long.status).toBe(400);
    const ok = await ADD_LINK(
      req("/api/ai/brain/links", "POST", { accountId: "acct_1", label: "加入名單", url: "https://example.com/w", description: "想加入時" })
    );
    expect(ok.status).toBe(201);
  });
});

describe("playground API", () => {
  it("queues a run and returns its result when the worker is done", async () => {
    const res = await PLAY(
      req("/api/ai/playground", "POST", { accountId: "acct_1", turns: [{ from: "person", text: "多少錢？" }] })
    );
    expect(res.status).toBe(202);
    const { data } = await res.json();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "ai-playground",
      { playgroundId: data.id, accountId: "acct_1", turns: [{ from: "person", text: "多少錢？" }] },
      expect.anything()
    );

    const pending = await (await POLL(req(`/api/ai/playground?id=${data.id}&accountId=acct_1`))).json();
    expect(pending.data).toEqual({ status: "pending" });
  });

  it("needs the last message to be from the person", async () => {
    const res = await PLAY(
      req("/api/ai/playground", "POST", { accountId: "acct_1", turns: [{ from: "creator", text: "嗨" }] })
    );
    expect(res.status).toBe(400);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe("unanswered questions", () => {
  it("groups the same question and puts the most asked first", async () => {
    mockPrisma.aiDraft.findMany.mockResolvedValue([
      { gapQuestion: "有沒有英文版？", inboundText: "有英文版嗎", createdAt: new Date(), username: "a" },
      { gapQuestion: "有沒有退款？", inboundText: "可以退款嗎", createdAt: new Date(), username: "b" },
      { gapQuestion: "有沒有英文版", inboundText: "english?", createdAt: new Date(), username: "c" },
    ]);
    const body = await (await GAPS(req("/api/ai/gaps?accountId=acct_1"))).json();
    expect(body.data.gaps[0]).toMatchObject({ question: "有沒有英文版？", count: 2, usernames: ["a", "c"] });
    expect(body.data.gaps[1]).toMatchObject({ question: "有沒有退款？", count: 1 });
  });
});
