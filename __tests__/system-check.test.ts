import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, redisMock, queueMock, healthMock } = vi.hoisted(() => ({
  prismaMock: {
    instagramAccount: { findMany: vi.fn() },
    operationalEvent: { findFirst: vi.fn() },
    dmLog: { count: vi.fn(), findFirst: vi.fn() },
    webhookEvent: { count: vi.fn() },
    workspace: { findMany: vi.fn() },
  },
  redisMock: { get: vi.fn(), set: vi.fn() },
  queueMock: { getJobCounts: vi.fn() },
  healthMock: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: prismaMock }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => queueMock,
  getRedisConnection: () => redisMock,
}));
vi.mock("@/lib/ops/worker-health", () => ({ getWorkerHealth: healthMock }));

import { checkSystem, checkWorkspace, runSystemCheck } from "@/lib/ops/system-check";

const account = (daysLeft: number, webhookSubscribed = true) => ({
  id: "a1",
  username: "leo",
  webhookSubscribed,
  tokenExpiresAt: new Date(Date.now() + daysLeft * 864e5),
});

describe("system check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.instagramAccount.findMany.mockResolvedValue([account(50)]);
    prismaMock.operationalEvent.findFirst.mockResolvedValue(null);
    prismaMock.dmLog.count.mockResolvedValue(0);
    prismaMock.dmLog.findFirst.mockResolvedValue(null);
    prismaMock.webhookEvent.count.mockResolvedValue(0);
    prismaMock.workspace.findMany.mockResolvedValue([{ id: "w1" }]);
    queueMock.getJobCounts.mockResolvedValue({ waiting: 0 });
    healthMock.mockResolvedValue({ healthy: true });
    redisMock.get.mockResolvedValue(null);
  });

  it("finds nothing on a healthy workspace", async () => {
    expect(await checkWorkspace("w1")).toEqual([]);
  });

  it("flags an expired token, one about to expire, and a missing webhook", async () => {
    prismaMock.instagramAccount.findMany.mockResolvedValue([account(-1)]);
    expect((await checkWorkspace("w1")).map((i) => i.id)).toEqual(["token-expired:a1"]);
    prismaMock.instagramAccount.findMany.mockResolvedValue([account(3, false)]);
    expect((await checkWorkspace("w1")).map((i) => i.id)).toEqual(["token-expiring:a1", "webhook-off:a1"]);
  });

  it("flags DM failures only when they outnumber the sends", async () => {
    prismaMock.dmLog.count.mockImplementation(async ({ where }: { where: { status: string } }) =>
      where.status === "FAILED" ? 12 : 50
    );
    expect(await checkWorkspace("w1")).toEqual([]);
    prismaMock.dmLog.count.mockImplementation(async ({ where }: { where: { status: string } }) =>
      where.status === "FAILED" ? 12 : 2
    );
    expect((await checkWorkspace("w1")).map((i) => i.id)).toEqual(["dm-failures"]);
  });

  it("checks the worker only when asked", async () => {
    healthMock.mockResolvedValue({ healthy: false });
    expect(await checkSystem({ includeWorker: false })).toEqual([]);
    expect((await checkSystem({ includeWorker: true })).map((i) => i.id)).toEqual(["worker-down"]);
  });

  it("mails a problem once, and again if the mail failed", async () => {
    prismaMock.instagramAccount.findMany.mockResolvedValue([account(-1)]);
    const deliver = vi.fn().mockRejectedValueOnce(new Error("mail down")).mockResolvedValue(undefined);

    await expect(runSystemCheck({ includeWorker: false, deliver })).rejects.toThrow("mail down");
    expect(redisMock.set).not.toHaveBeenCalled();

    expect(await runSystemCheck({ includeWorker: false, deliver })).toBe(1);
    expect(redisMock.set).toHaveBeenCalledTimes(1);

    redisMock.get.mockResolvedValue("1");
    deliver.mockClear();
    expect(await runSystemCheck({ includeWorker: false, deliver })).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("token refresh failures", () => {
  it("are ignored once the token has plenty of time left", async () => {
    prismaMock.instagramAccount.findMany.mockResolvedValue([account(50)]);
    prismaMock.operationalEvent.findFirst.mockResolvedValue({ message: "old failure" });
    prismaMock.dmLog.count.mockResolvedValue(0);
    prismaMock.webhookEvent.count.mockResolvedValue(0);
    expect(await checkWorkspace("w1")).toEqual([]);

    prismaMock.instagramAccount.findMany.mockResolvedValue([account(8)]);
    expect((await checkWorkspace("w1")).map((i) => i.id)).toEqual(["token-refresh-failed"]);
  });
});
