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
    prismaMock.dmLog.count.mockImplementation(async ({ where }: { where: { status: unknown; publicReplySentAt?: unknown } }) =>
      where.publicReplySentAt ? 0 : where.status === "FAILED" ? 12 : 50
    );
    expect(await checkWorkspace("w1")).toEqual([]);
    prismaMock.dmLog.count.mockImplementation(async ({ where }: { where: { status: unknown; publicReplySentAt?: unknown } }) =>
      where.publicReplySentAt ? 0 : where.status === "FAILED" ? 12 : 2
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
    redisMock.get.mockResolvedValue(null);
    expect(await checkWorkspace("w1")).toEqual([]);

    prismaMock.instagramAccount.findMany.mockResolvedValue([account(8)]);
    expect((await checkWorkspace("w1")).map((i) => i.id)).toEqual(["token-refresh-failed"]);
  });
});

describe("new checks", () => {
  beforeEach(() => {
    prismaMock.instagramAccount.findMany.mockResolvedValue([{ ...account(50), instagramId: "ig1" }]);
    prismaMock.operationalEvent.findFirst.mockResolvedValue(null);
    prismaMock.dmLog.count.mockResolvedValue(0);
    prismaMock.webhookEvent.count.mockResolvedValue(0);
    queueMock.getJobCounts.mockResolvedValue({ waiting: 0 });
    redisMock.get.mockResolvedValue(null);
  });

  it("flags a refused token and Instagram throttling", async () => {
    redisMock.get.mockImplementation(async (k: string) =>
      k === "token-invalid:ig1" || k === "cooldown:dm:ig1" ? "1" : null
    );
    expect((await checkWorkspace("w1")).map((i) => i.id)).toEqual(["token-rejected:a1", "throttled:a1"]);
  });

  it("flags comments answered in public whose DM never followed", async () => {
    prismaMock.dmLog.count.mockImplementation(async ({ where }: { where: { publicReplySentAt?: unknown } }) =>
      where.publicReplySentAt ? 3 : 0
    );
    expect((await checkWorkspace("w1")).map((i) => i.id)).toEqual(["replied-no-dm"]);
  });

  it("flags a cron that stopped, but not one with no baseline yet", async () => {
    expect(await checkSystem({ includeWorker: false })).toEqual([]);
    redisMock.get.mockResolvedValue(String(Date.now() - 27 * 3600_000));
    expect((await checkSystem({ includeWorker: false })).map((i) => i.id)).toEqual(["cron-late"]);
  });
});
