import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const drafts: Row[] = [];
  const claims = new Set<string>();
  const lists = new Map<string, string[]>();
  let seq = 0;

  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, value] of Object.entries(where)) {
      if (key === "OR") {
        if (!(value as Row[]).some((w) => matches(row, w))) return false;
        continue;
      }
      if (value && typeof value === "object" && !(value instanceof Date)) {
        const cond = value as { in?: unknown[]; lt?: Date; gte?: Date };
        if (cond.in && !cond.in.includes(row[key])) return false;
        if (cond.lt && !((row[key] as Date) < cond.lt)) return false;
        if (cond.gte && !((row[key] as Date) >= cond.gte)) return false;
        continue;
      }
      if (row[key] !== value) return false;
    }
    return true;
  }

  const aiDraft = {
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      const compound = where.instagramAccountId_inboundMessageId as Row | undefined;
      const row = drafts.find((d) => (compound ? matches(d, compound) : matches(d, where)));
      return row ? { ...row } : null;
    }),
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      const row = drafts.find((d) => matches(d, where));
      return row ? { ...row } : null;
    }),
    findMany: vi.fn(async ({ where }: { where: Row }) => drafts.filter((d) => matches(d, where)).map((d) => ({ ...d }))),
    count: vi.fn(async ({ where }: { where: Row }) => drafts.filter((d) => matches(d, where)).length),
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (
        drafts.some(
          (d) => d.instagramAccountId === data.instagramAccountId && d.inboundMessageId === data.inboundMessageId
        )
      ) {
        throw { code: "P2002" };
      }
      const row = { id: `draft_${++seq}`, status: "PENDING", createdAt: new Date(), ...data };
      drafts.push(row);
      return { ...row };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const rows = drafts.filter((d) => matches(d, where));
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    }),
    groupBy: vi.fn(async ({ where }: { where: Row }) => {
      const groups = new Map<string, Row>();
      for (const d of drafts.filter((row) => matches(row, where))) {
        const key = `${d.instagramAccountId}:${d.igsid}`;
        const current = groups.get(key);
        const max = current ? (current._max as { inboundAt: Date }).inboundAt : null;
        if (!max || (d.inboundAt as Date) > max) {
          groups.set(key, {
            instagramAccountId: d.instagramAccountId,
            igsid: d.igsid,
            _max: { inboundAt: d.inboundAt },
          });
        }
      }
      return [...groups.values()];
    }),
  };

  return {
    drafts,
    claims,
    lists,
    reset() {
      drafts.length = 0;
      claims.clear();
      lists.clear();
      seq = 0;
    },
    mockPrisma: {
      aiDraft,
      instagramAccount: { findUnique: vi.fn() },
      contact: { findUnique: vi.fn() },
      automation: { findMany: vi.fn() },
      postbackDelivery: {
        create: vi.fn(async ({ data }: { data: { id: string } }) => {
          if (claims.has(data.id)) throw { code: "P2002" };
          claims.add(data.id);
          return data;
        }),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          claims.delete(where.id);
        }),
      },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    },
    redis: {
      lrange: vi.fn(async (key: string) => [...(lists.get(key) ?? [])]),
      ltrim: vi.fn(async (key: string, start: number) => {
        lists.set(key, (lists.get(key) ?? []).slice(start));
      }),
    },
    mockFindConversation: vi.fn(),
    mockGetMessages: vi.fn(),
    mockSendDirectMessage: vi.fn(),
    mockQueueAdd: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: h.mockPrisma }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => h.redis }));
vi.mock("@/lib/ops/worker-health", () => ({ recordWorkerAlert: vi.fn() }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  findConversationWithUser: h.mockFindConversation,
  getConversationMessages: h.mockGetMessages,
}));
vi.mock("@/lib/instagram/provider", () => ({
  createInstagramContext: vi.fn(async (account: { provider: string }) =>
    account.provider === "META" ? { provider: "META", accessToken: "token" } : { provider: "ZERNIO" }
  ),
  hasInstagramCredentials: (account: { accessToken?: string }) => Boolean(account.accessToken),
  sendDirectMessage: h.mockSendDirectMessage,
}));
vi.mock("@/lib/ai/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/queue")>()),
  getAiQueue: () => ({ add: h.mockQueueAdd }),
}));

import { MetaApiError, PermissionError } from "@/lib/meta/client";
import { processAiDraft, processSendAiDraft } from "../lib/ai/worker";
import { requestDraftSend, dismissDraft, expireStaleAiDrafts } from "../lib/ai/drafts";
import { burstKey } from "../lib/ai/trigger";

const DISCLOSURE = "（我是 AI 小助理，訊息經過本人確認後送出）";
const NOW = new Date("2026-10-09T10:01:00.000Z");

const assistant = {
  enabled: true,
  model: "claude-haiku-5-5",
  role: "Leo 的小助理",
  voice: "親切",
  guardrails: "",
  knowledge: "線上課程 NT$1,200",
  disclosureText: DISCLOSURE,
  dailyDraftCapPerPerson: 10,
};
const account = {
  id: "acct_1",
  workspaceId: "ws_1",
  instagramId: "ig_456",
  provider: "META",
  accessToken: "encrypted",
  zernioAccountId: null,
  aiAssistant: assistant,
};

function claudeReply(overrides: Record<string, unknown> = {}): Anthropic.Message {
  return {
    content: [
      { type: "thinking", thinking: "", signature: "s" },
      {
        type: "text",
        text: JSON.stringify({
          reply_text: "課程是 NT$1,200 喔！",
          intent: "pricing",
          needs_human: false,
          handoff_reason: null,
          language: "zh-TW",
          confidence: "high",
          ...overrides,
        }),
      },
    ],
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

let create: ReturnType<typeof vi.fn>;
const deps = () => ({ getClient: () => ({ messages: { create } }) as never });

function job(messageId = "mid_2", extra: Record<string, unknown> = {}) {
  return {
    data: {
      accountId: "acct_1",
      instagramAccountId: "ig_456",
      igsid: "fan_1",
      messageId,
      messageText: "fallback text",
      receivedAt: NOW.getTime() - 10_000,
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...extra,
  };
}

function seedBurst(...entries: [string, string][]) {
  h.lists.set(
    burstKey("acct_1", "fan_1"),
    entries.map(([id, text], i) => JSON.stringify({ id, text, at: NOW.getTime() - 20_000 + i * 1000 }))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.reset();
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
  create = vi.fn(async () => claudeReply());
  h.mockPrisma.instagramAccount.findUnique.mockResolvedValue(account);
  h.mockPrisma.contact.findUnique.mockResolvedValue({ id: "contact_1", username: null });
  h.mockPrisma.automation.findMany.mockResolvedValue([]);
  h.mockFindConversation.mockResolvedValue("conv_1");
  // Meta lists newest first.
  h.mockGetMessages.mockResolvedValue([
    { id: "mid_2", message: "還有優惠嗎？", from: { id: "fan_1", username: "fan.one" }, created_time: "2026-10-09T10:00:20+0000" },
    { id: "mid_1", message: "我的信箱 fan@example.com，想問課程", from: { id: "fan_1", username: "fan.one" }, created_time: "2026-10-09T10:00:05+0000" },
    { id: "out_1", message: "歡迎追蹤！", from: { id: "ig_456" }, created_time: "2026-10-08T09:00:00+0000" },
  ]);
  h.mockSendDirectMessage.mockResolvedValue({ recipient_id: "fan_1", message_id: "sent_mid_1" });
  h.mockQueueAdd.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("processAiDraft", () => {
  it("writes one draft for a burst, from the Meta history, with emails masked", async () => {
    seedBurst(["mid_1", "(message with an email)"], ["mid_2", "還有優惠嗎？"]);

    await expect(processAiDraft(job("mid_2"), deps())).resolves.toBe("created");

    expect(create).toHaveBeenCalledTimes(1);
    const body = (create.mock.calls[0] as unknown as [Anthropic.MessageCreateParamsNonStreaming])[0];
    const prompt = JSON.stringify(body);
    expect(prompt).not.toContain("fan@example.com");
    expect(prompt).toContain("歡迎追蹤！"); // the creator's earlier reply is context

    expect(h.drafts).toHaveLength(1);
    const draft = h.drafts[0];
    expect(draft).toMatchObject({
      status: "PENDING",
      inboundMessageId: "mid_2",
      inboundText: "(message with an email)\n還有優惠嗎？",
      draftText: "課程是 NT$1,200 喔！",
      intent: "pricing",
      needsHuman: false,
      username: "fan.one",
      contactId: "contact_1",
      model: "claude-haiku-5-5",
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 900,
    });
    expect((draft.inboundAt as Date).toISOString()).toBe("2026-10-09T10:00:20.000Z");
    expect(JSON.stringify(draft.historySnapshot)).not.toContain("fan@example.com");
    // The burst is consumed.
    expect(h.lists.get(burstKey("acct_1", "fan_1"))).toEqual([]);
  });

  it("leaves an older message of a burst to the newest message's job", async () => {
    seedBurst(["mid_1", "想問課程"], ["mid_2", "還有優惠嗎？"]);

    await expect(processAiDraft(job("mid_1"), deps())).resolves.toBe("superseded");
    expect(create).not.toHaveBeenCalled();
    expect(h.drafts).toHaveLength(0);
  });

  it("supersedes the person's older pending draft when a new one is written", async () => {
    h.drafts.push({
      id: "old",
      instagramAccountId: "acct_1",
      igsid: "fan_1",
      inboundMessageId: "mid_0",
      status: "PENDING",
      createdAt: new Date(),
      inboundAt: new Date(),
    });
    seedBurst(["mid_2", "還有優惠嗎？"]);

    await processAiDraft(job("mid_2"), deps());

    expect(h.drafts.find((d) => d.id === "old")?.status).toBe("SUPERSEDED");
    expect(h.drafts.filter((d) => d.status === "PENDING")).toHaveLength(1);
  });

  it("ignores a redelivered message that already has a draft", async () => {
    h.drafts.push({ id: "d", instagramAccountId: "acct_1", inboundMessageId: "mid_2", igsid: "fan_1", status: "PENDING" });

    await expect(processAiDraft(job("mid_2"), deps())).resolves.toBe("duplicate");
    expect(create).not.toHaveBeenCalled();
  });

  it("stops at the daily cap per person", async () => {
    for (let i = 0; i < 2; i++) {
      h.drafts.push({ id: `c${i}`, instagramAccountId: "acct_1", igsid: "fan_1", inboundMessageId: `x${i}`, status: "DISMISSED", createdAt: new Date() });
    }
    h.mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      ...account,
      aiAssistant: { ...assistant, dailyDraftCapPerPerson: 2 },
    });

    await expect(processAiDraft(job(), deps())).resolves.toBe("capped");
    expect(create).not.toHaveBeenCalled();
  });

  it("skips when the assistant is off, the account is Zernio, or the worker has no key", async () => {
    h.mockPrisma.instagramAccount.findUnique.mockResolvedValueOnce({ ...account, aiAssistant: { ...assistant, enabled: false } });
    await expect(processAiDraft(job(), deps())).resolves.toBe("skipped");

    h.mockPrisma.instagramAccount.findUnique.mockResolvedValueOnce({ ...account, provider: "ZERNIO" });
    await expect(processAiDraft(job(), deps())).resolves.toBe("skipped");

    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(processAiDraft(job(), deps())).resolves.toBe("skipped");
    expect(create).not.toHaveBeenCalled();
  });

  it("falls back to the inbound text when the history cannot be loaded", async () => {
    h.mockFindConversation.mockRejectedValue(new MetaApiError(1, undefined, undefined, "boom"));

    await expect(processAiDraft(job("mid_2"), deps())).resolves.toBe("created");
    expect(h.drafts[0]).toMatchObject({ inboundText: "fallback text" });
    expect(JSON.stringify(create.mock.calls[0])).toContain("fallback text");
  });

  it("skips a message the creator already answered in the Instagram app", async () => {
    h.mockGetMessages.mockResolvedValue([
      { id: "out_2", message: "馬上回你", from: { id: "ig_456" }, created_time: "2026-10-09T10:00:30+0000" },
      { id: "mid_2", message: "還有優惠嗎？", from: { id: "fan_1" }, created_time: "2026-10-09T10:00:20+0000" },
    ]);

    await expect(processAiDraft(job("mid_2"), deps())).resolves.toBe("answered");
    expect(create).not.toHaveBeenCalled();
  });

  it("lets BullMQ retry a transient failure, and records FAILED on the last attempt", async () => {
    const { AiGenerationError } = await import("../lib/ai/generate");
    create.mockRejectedValue(new AiGenerationError("Claude API rate limited", true));

    await expect(processAiDraft(job("mid_2"), deps())).rejects.toThrow("rate limited");
    expect(h.drafts).toHaveLength(0);

    await expect(processAiDraft(job("mid_2", { attemptsMade: 2 }), deps())).resolves.toBe("failed");
    expect(h.drafts[0]).toMatchObject({ status: "FAILED", error: "Claude API rate limited" });
  });

  it("records a refusal as FAILED without retrying", async () => {
    create.mockResolvedValue({
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "general_harms", explanation: null },
      usage: { input_tokens: 1, output_tokens: 0 },
    });

    await expect(processAiDraft(job("mid_2"), deps())).resolves.toBe("failed");
    expect(h.drafts[0].status).toBe("FAILED");
    expect(h.drafts[0].error).toMatch(/declined/);
  });

  it("keeps the first reply short enough for the disclosure", async () => {
    create.mockResolvedValue(claudeReply({ reply_text: "好".repeat(400) }));

    await processAiDraft(job("mid_2"), deps());
    const text = `${DISCLOSURE}\n${h.drafts[0].draftText}`;
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1000);
  });
});

function seedDraft(fields: Row = {}) {
  const row = {
    id: "draft_x",
    workspaceId: "ws_1",
    instagramAccountId: "acct_1",
    igsid: "fan_1",
    inboundMessageId: "mid_9",
    inboundAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    status: "PENDING",
    draftText: "課程是 NT$1,200 喔！",
    createdAt: new Date(),
    instagramAccount: { aiAssistant: { disclosureText: DISCLOSURE } },
    ...fields,
  };
  h.drafts.push(row);
  return row;
}

describe("requestDraftSend", () => {
  it("prepends the disclosure to the first reply and queues the send", async () => {
    seedDraft();

    const result = await requestDraftSend({ workspaceId: "ws_1", draftId: "draft_x", text: " 課程 NT$1,200 ", now: NOW });

    expect(result).toEqual({ ok: true, status: "SENDING" });
    expect(h.drafts[0]).toMatchObject({ status: "SENDING", finalText: `${DISCLOSURE}\n課程 NT$1,200` });
    expect(h.mockQueueAdd).toHaveBeenCalledWith(
      "send-ai-draft",
      { draftId: "draft_x" },
      expect.objectContaining({ jobId: expect.stringMatching(/^send-ai-draft_draft_x_/) })
    );
  });

  it("does not repeat the disclosure once the person has received an AI reply", async () => {
    seedDraft();
    h.drafts.push({ id: "earlier", workspaceId: "ws_1", instagramAccountId: "acct_1", igsid: "fan_1", status: "SENT", inboundAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) });

    await requestDraftSend({ workspaceId: "ws_1", draftId: "draft_x", text: "好的！", now: NOW });
    expect(h.drafts[0].finalText).toBe("好的！");
  });

  it("allows exactly one send when approved twice (compare-and-set)", async () => {
    seedDraft();

    const [first, second] = await Promise.all([
      requestDraftSend({ workspaceId: "ws_1", draftId: "draft_x", text: "A", now: NOW }),
      requestDraftSend({ workspaceId: "ws_1", draftId: "draft_x", text: "B", now: NOW }),
    ]);
    const outcomes = [first, second].map((r) => r.ok);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(h.mockQueueAdd).toHaveBeenCalledTimes(1);

    // And a draft already SENDING can't be sent again.
    const third = await requestDraftSend({ workspaceId: "ws_1", draftId: "draft_x", text: "C", now: NOW });
    expect(third).toMatchObject({ ok: false, httpStatus: 409 });
  });

  it("expires the draft once the person's last message is 24 hours old", async () => {
    seedDraft({ inboundAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) });

    const result = await requestDraftSend({ workspaceId: "ws_1", draftId: "draft_x", text: "hi", now: NOW });

    expect(result).toMatchObject({ ok: false, httpStatus: 410, code: "window_closed" });
    expect(h.drafts[0].status).toBe("EXPIRED");
    expect(h.mockQueueAdd).not.toHaveBeenCalled();
  });

  it("counts a newer message from the same person as reopening the window", async () => {
    seedDraft({ inboundAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000), status: "FAILED" });
    h.drafts.push({ id: "newer", workspaceId: "ws_1", instagramAccountId: "acct_1", igsid: "fan_1", status: "DISMISSED", inboundAt: new Date(NOW.getTime() - 60_000) });

    const result = await requestDraftSend({ workspaceId: "ws_1", draftId: "draft_x", text: "hi", now: NOW });
    expect(result.ok).toBe(true);
  });

  it("rejects empty and over-long replies, and drafts from another workspace", async () => {
    seedDraft();
    await expect(requestDraftSend({ workspaceId: "ws_1", draftId: "draft_x", text: "  ", now: NOW })).resolves.toMatchObject({ httpStatus: 400, code: "empty" });
    await expect(
      requestDraftSend({ workspaceId: "ws_1", draftId: "draft_x", text: "字".repeat(330), now: NOW })
    ).resolves.toMatchObject({ httpStatus: 400, code: "too_long" });
    await expect(requestDraftSend({ workspaceId: "ws_2", draftId: "draft_x", text: "hi", now: NOW })).resolves.toMatchObject({ httpStatus: 404 });
    expect(h.drafts[0].status).toBe("PENDING");
  });

  it("puts the draft back when the queue is unavailable", async () => {
    seedDraft();
    h.mockQueueAdd.mockRejectedValueOnce(new Error("redis down"));

    await expect(requestDraftSend({ workspaceId: "ws_1", draftId: "draft_x", text: "hi", now: NOW })).resolves.toMatchObject({ httpStatus: 503 });
    expect(h.drafts[0]).toMatchObject({ status: "PENDING", finalText: null });
  });
});

describe("dismissing and expiring", () => {
  it("dismisses a pending draft once", async () => {
    seedDraft();
    await expect(dismissDraft({ workspaceId: "ws_1", draftId: "draft_x" })).resolves.toBe(true);
    await expect(dismissDraft({ workspaceId: "ws_1", draftId: "draft_x" })).resolves.toBe(false);
    expect(h.drafts[0].status).toBe("DISMISSED");
  });

  it("expires only pending drafts past the 24-hour window", async () => {
    seedDraft({ id: "stale", inboundMessageId: "a", inboundAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) });
    seedDraft({ id: "fresh", inboundMessageId: "b" });
    seedDraft({ id: "sent", inboundMessageId: "c", status: "SENT", inboundAt: new Date(0) });

    await expect(expireStaleAiDrafts({ workspaceId: "ws_1" }, NOW)).resolves.toBe(1);
    expect(h.drafts.map((d) => d.status)).toEqual(["EXPIRED", "PENDING", "SENT"]);
  });
});

describe("processSendAiDraft", () => {
  function sendingDraft(fields: Row = {}) {
    return seedDraft({
      status: "SENDING",
      finalText: `${DISCLOSURE}\n好的！`,
      instagramAccount: { id: "acct_1", instagramId: "ig_456", provider: "META", accessToken: "encrypted", workspaceId: "ws_1", zernioAccountId: null },
      ...fields,
    });
  }

  it("sends the approved text once and marks it SENT", async () => {
    sendingDraft();

    await expect(processSendAiDraft({ data: { draftId: "draft_x" } })).resolves.toBe("sent");
    expect(h.mockSendDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({ instagramAccountId: "ig_456", userId: "fan_1", message: `${DISCLOSURE}\n好的！` })
    );
    expect(h.drafts[0]).toMatchObject({ status: "SENT", sentMessageId: "sent_mid_1" });

    // A duplicate job finds the draft no longer SENDING.
    await expect(processSendAiDraft({ data: { draftId: "draft_x" } })).resolves.toBe("skipped");
    expect(h.mockSendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("never sends twice when the durable claim already exists", async () => {
    sendingDraft();
    h.claims.add("ai-draft-send:draft_x");

    await expect(processSendAiDraft({ data: { draftId: "draft_x" } })).resolves.toBe("already_claimed");
    expect(h.mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("marks a confirmed Meta rejection FAILED and releases the claim", async () => {
    sendingDraft();
    h.mockSendDirectMessage.mockRejectedValue(new PermissionError("outside of allowed window"));

    await expect(processSendAiDraft({ data: { draftId: "draft_x" } })).resolves.toBe("failed");
    expect(h.drafts[0]).toMatchObject({ status: "FAILED" });
    expect(String(h.drafts[0].error)).toContain("outside of allowed window");
    expect(h.claims.has("ai-draft-send:draft_x")).toBe(false);
  });

  it("keeps an unconfirmed delivery SENDING with the error and does not retry", async () => {
    sendingDraft();
    h.mockSendDirectMessage.mockRejectedValue(new MetaApiError(1, undefined, undefined, "An unknown error occurred"));

    await expect(processSendAiDraft({ data: { draftId: "draft_x" } })).rejects.toMatchObject({ name: "UnrecoverableError" });
    expect(h.drafts[0].status).toBe("SENDING");
    expect(String(h.drafts[0].error)).toMatch(/unconfirmed/i);
    expect(h.claims.has("ai-draft-send:draft_x")).toBe(true);
  });
});
