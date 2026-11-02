import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, redisMock, queueMock, healthMock } = vi.hoisted(() => ({
  prismaMock: {
    instagramAccount: { findMany: vi.fn() },
    operationalEvent: { findFirst: vi.fn(), count: vi.fn() },
    automation: { count: vi.fn() },
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
    prismaMock.operationalEvent.count.mockResolvedValue(0);
    prismaMock.automation.count.mockResolvedValue(10);
    prismaMock.dmLog.count.mockResolvedValue(0);
    prismaMock.dmLog.findFirst.mockResolvedValue(null);
    prismaMock.webhookEvent.count.mockResolvedValue(0);
    prismaMock.workspace.findMany.mockResolvedValue([{ id: "w1" }]);
    queueMock.getJobCounts.mockResolvedValue({ waiting: 0, delayed: 0 });
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

  it("flags DM failures when at least a quarter of the sends fail", async () => {
    const counts = (failed: number, sent: number) =>
      prismaMock.dmLog.count.mockImplementation(async ({ where }: { where: { status: unknown } }) =>
        where.status === "FAILED" ? failed : where.status === "SENT" ? sent : 0
      );
    counts(19, 2);
    expect(await checkWorkspace("w1")).toEqual([]);
    counts(20, 300);
    expect(await checkWorkspace("w1")).toEqual([]);
    counts(100, 300);
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
  beforeEach(() => {
    prismaMock.operationalEvent.findFirst.mockResolvedValue({ message: "failure" });
    prismaMock.dmLog.count.mockResolvedValue(0);
    prismaMock.webhookEvent.count.mockResolvedValue(0);
  });

  it("are ignored while a proven renewal still has time", async () => {
    redisMock.get.mockImplementation(async (k: string) => (k === "ops:token-renewal-proven" ? "yes" : null));
    prismaMock.instagramAccount.findMany.mockResolvedValue([account(50)]);
    expect(await checkWorkspace("w1")).toEqual([]);

    prismaMock.instagramAccount.findMany.mockResolvedValue([account(8)]);
    expect((await checkWorkspace("w1")).map((i) => i.id)).toEqual(["token-refresh-failed"]);
  });

  it("count from the first try when no renewal has worked yet, and not before it", async () => {
    redisMock.get.mockResolvedValue(null);
    prismaMock.instagramAccount.findMany.mockResolvedValue([account(59.5)]);
    expect(await checkWorkspace("w1")).toEqual([]);

    prismaMock.instagramAccount.findMany.mockResolvedValue([account(58)]);
    expect((await checkWorkspace("w1")).map((i) => i.id)).toEqual(["token-refresh-failed"]);
  });
});

describe("what gets mailed", () => {
  beforeEach(() => {
    prismaMock.instagramAccount.findMany.mockResolvedValue([{ ...account(50), instagramId: "ig1" }]);
    prismaMock.operationalEvent.findFirst.mockResolvedValue(null);
    prismaMock.operationalEvent.count.mockResolvedValue(0);
    prismaMock.automation.count.mockResolvedValue(10);
    prismaMock.dmLog.count.mockResolvedValue(0);
    prismaMock.webhookEvent.count.mockResolvedValue(0);
    queueMock.getJobCounts.mockResolvedValue({ waiting: 0, delayed: 0 });
    redisMock.get.mockResolvedValue(null);
  });

  it("flags a refused token, and says nothing about a cooldown that clears by itself", async () => {
    redisMock.get.mockImplementation(async (k: string) =>
      k === "token-invalid:ig1" || k === "cooldown:dm:ig1" ? "1" : null
    );
    expect((await checkWorkspace("w1")).map((i) => i.id)).toEqual(["token-rejected:a1"]);
  });

  it("flags comments still waiting for their DM after three hours, whatever the cause", async () => {
    const stuck = (count: number) =>
      prismaMock.dmLog.count.mockImplementation(async ({ where }: { where: { status: unknown } }) =>
        where.status === "PENDING" ? count : 0
      );
    stuck(4);
    expect(await checkWorkspace("w1")).toEqual([]);
    stuck(5);
    expect((await checkWorkspace("w1")).map((i) => i.id)).toEqual(["comments-stuck"]);
    const where = prismaMock.dmLog.count.mock.calls.find(([q]) => q.where.status === "PENDING")![0].where;
    expect(where.NOT).toEqual({ commentId: { startsWith: "reveal:" } });
    expect(Date.now() - where.createdAt.lt.getTime()).toBeCloseTo(3 * 3600_000, -3);
  });

  it("flags the sweep failing on at least half its runs in the last hour", async () => {
    prismaMock.operationalEvent.count.mockResolvedValue(59);
    expect(await checkWorkspace("w1")).toEqual([]);
    prismaMock.operationalEvent.count.mockResolvedValue(60);
    expect((await checkWorkspace("w1")).map((i) => i.id)).toEqual(["sweep-failures"]);
  });

  it("counts waiting and delayed jobs towards a runaway queue", async () => {
    queueMock.getJobCounts.mockResolvedValue({ waiting: 100, delayed: 2900 });
    expect(await checkSystem({ includeWorker: false })).toEqual([]);
    queueMock.getJobCounts.mockResolvedValue({ waiting: 100, delayed: 2901 });
    expect((await checkSystem({ includeWorker: false })).map((i) => i.id)).toEqual(["queue-backlog"]);
  });

  it("every mail says whether anything is needed from the owner", async () => {
    prismaMock.instagramAccount.findMany.mockResolvedValue([{ ...account(-1, false), instagramId: "ig1" }]);
    redisMock.get.mockImplementation(async (k: string) => (k === "token-invalid:ig1" ? "1" : null));
    prismaMock.dmLog.count.mockResolvedValue(100);
    prismaMock.webhookEvent.count.mockResolvedValue(10);
    prismaMock.operationalEvent.count.mockResolvedValue(100);
    prismaMock.operationalEvent.findFirst.mockResolvedValue({ message: "failure" });
    queueMock.getJobCounts.mockResolvedValue({ waiting: 5000, delayed: 0 });
    healthMock.mockResolvedValue({ healthy: false });

    const issues = [...(await checkWorkspace("w1")), ...(await checkSystem({ includeWorker: true }))];

    expect(issues.length).toBeGreaterThanOrEqual(8);
    for (const issue of issues) {
      expect(issue.detail).toMatch(/^(要你動手|不用動手|交給 Claude)：/);
    }
  });
});
