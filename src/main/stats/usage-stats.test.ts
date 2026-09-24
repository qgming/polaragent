import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionStore, UsageSample, UsageScanResult } from "@/main/pisdk/session-store";
import type { SessionSummary } from "@/shared/contracts/session";
import { ROLLUP_VERSION, readRollupFile } from "./usage-rollup";
import { createUsageStatsService } from "./usage-stats";

/**
 * 服务层的三件事必须钉住：**增量**（重启后不重扫）、**预算**（一次不把主进程按住）、
 * **失败可辨**（列表读不到要抛错，而不是给一份全 0 的假报告）。
 *
 * 假的会话库只实现服务真正用到的那两个方法（list / scanUsageSamples）：
 * 其余方法属于会话域，统计不碰 —— 这也正是这层接口的形状是否合适的检查点。
 */

interface FakeSession {
  id: string;
  title?: string | null;
  kind?: "chat" | "subagent";
  createdAt: number;
  updatedAt: number;
  /** 全部样本，按 seq 顺序（每条样本一条「条目」） */
  samples: UsageSample[];
}

function summaryOf(session: FakeSession): SessionSummary {
  return {
    id: session.id,
    title: session.title ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cwd: "",
    kind: session.kind ?? "chat",
    archived: false,
    pinned: false,
    messageCount: session.samples.length,
    model: null,
  };
}

/** 记录每一次扫描的调用参数，用来断言「稳态下不再开库」与游标推进 */
interface FakeStore {
  store: SessionStore;
  calls: { id: string; afterSeq: number; maxEntries: number }[];
}

function fakeStore(sessions: FakeSession[]): FakeStore {
  const calls: FakeStore["calls"] = [];
  const store = {
    list: async (): Promise<SessionSummary[]> => sessions.map(summaryOf),
    scanUsageSamples: async (
      id: string,
      afterSeq: number,
      maxEntries: number,
    ): Promise<UsageScanResult> => {
      calls.push({ id, afterSeq, maxEntries });
      const session = sessions.find((entry) => entry.id === id);
      if (session === undefined) return { samples: [], nextSeq: afterSeq, entries: 0, done: true };
      const slice = session.samples.slice(afterSeq, afterSeq + maxEntries);
      const nextSeq = afterSeq + slice.length;
      return {
        samples: slice,
        nextSeq,
        entries: slice.length,
        done: nextSeq >= session.samples.length,
      };
    },
  } as unknown as SessionStore;
  return { store, calls };
}

function sample(overrides: Partial<UsageSample> & { at: number }): UsageSample {
  return {
    serviceId: "svc",
    modelId: "m1",
    inputTokens: 0,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

function session(overrides: Partial<FakeSession> & { id: string }): FakeSession {
  return {
    createdAt: 0,
    updatedAt: 10,
    samples: [],
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "oint-stats-"));
  dirs.push(dir);
  return path.join(dir, "usage-stats.json");
}

const NOW = new Date(2026, 8, 24, 12).getTime();

describe("report", () => {
  it("折出日与模型维度的报告", async () => {
    const { store } = fakeStore([
      session({
        id: "s1",
        title: "会话一",
        updatedAt: 20,
        createdAt: 0,
        samples: [
          sample({ at: NOW, outputTokens: 5 }),
          sample({ at: NOW, modelId: "m2", outputTokens: 7 }),
        ],
      }),
    ]);
    const service = createUsageStatsService({ store, filePath: await tempFile(), now: () => NOW });
    const report = await service.report();

    expect(report.totalTokens).toBe(12);
    expect(report.days[0]?.date).toBe("2026-09-24");
    expect(report.models.map((model) => model.modelId).sort()).toEqual(["m1", "m2"]);
    expect(report.scanning).toEqual({ active: false, scanned: 1, total: 1 });
    expect(report.today).toBe("2026-09-24");
  });

  it("稳态下第二次调用**一个 SQLite 都不开**（靠 updatedAt 快照跳过）", async () => {
    const { store, calls } = fakeStore([
      session({ id: "s1", updatedAt: 20, samples: [sample({ at: NOW })] }),
    ]);
    const service = createUsageStatsService({ store, filePath: await tempFile(), now: () => NOW });
    await service.report();
    expect(calls).toHaveLength(1);

    await service.report();
    expect(calls).toHaveLength(1);
  });

  it("会话有了新消息（updatedAt 前进）才重扫，且从上次的游标接着扫", async () => {
    const sessions = [session({ id: "s1", updatedAt: 20, samples: [sample({ at: NOW })] })];
    const { store, calls } = fakeStore(sessions);
    const service = createUsageStatsService({ store, filePath: await tempFile(), now: () => NOW });
    await service.report();

    const target = sessions[0];
    if (target === undefined) throw new Error("用例数据缺失");
    target.samples.push(sample({ at: NOW, outputTokens: 3 }));
    target.updatedAt = 30;
    const report = await service.report();

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ id: "s1", afterSeq: 1 });
    expect(report.totalTokens).toBe(4);
  });

  it("预算用尽时带着 scanning.active 返回，下一次接着折（累计数据不会丢）", async () => {
    // 40 个会话、每个 1 条样本：一次请求只折 SESSION_BUDGET(24) 个
    const sessions = Array.from({ length: 40 }, (_, index) =>
      session({ id: `s${index}`, updatedAt: 20, samples: [sample({ at: NOW })] }),
    );
    const { store } = fakeStore(sessions);
    const service = createUsageStatsService({ store, filePath: await tempFile(), now: () => NOW });

    const first = await service.report();
    expect(first.scanning.active).toBe(true);
    expect(first.scanning.total).toBe(40);
    expect(first.scanning.scanned).toBe(24);

    const second = await service.report();
    expect(second.scanning.active).toBe(false);
    expect(second.scanning.scanned).toBe(40);
    // ⚠️ 回归：第二轮必须在第一轮的结果上继续累加
    //（曾经的实现把「内存账本」锁在首次解析的 Promise 里，于是每轮都从零开始，
    //  表现为「正在整理历史用量」永远转不完）
    expect(second.totalTokens).toBe(40);
    expect(second.totalTokens).toBeGreaterThan(first.totalTokens);
  });

  it("重启（新的服务实例）读回落盘的账本，不重新扫描", async () => {
    const filePath = await tempFile();
    const sessions = [session({ id: "s1", updatedAt: 20, samples: [sample({ at: NOW })] })];
    const first = fakeStore(sessions);
    await createUsageStatsService({ store: first.store, filePath, now: () => NOW }).report();
    expect(first.calls).toHaveLength(1);

    const second = fakeStore(sessions);
    const report = await createUsageStatsService({
      store: second.store,
      filePath,
      now: () => NOW,
    }).report();
    expect(second.calls).toHaveLength(0);
    expect(report.totalTokens).toBe(1);
  });

  it("会话被删掉后它的用量从报告里消失（卷账本里那条也一并丢掉）", async () => {
    const filePath = await tempFile();
    const sessions = [
      session({ id: "s1", updatedAt: 20, samples: [sample({ at: NOW, outputTokens: 10 })] }),
      session({ id: "s2", updatedAt: 20, samples: [sample({ at: NOW, outputTokens: 5 })] }),
    ];
    const store = fakeStore(sessions);
    await createUsageStatsService({ store: store.store, filePath, now: () => NOW }).report();

    sessions.splice(0, 1);
    const report = await createUsageStatsService({
      store: fakeStore(sessions).store,
      filePath,
      now: () => NOW,
    }).report();
    expect(report.totalTokens).toBe(5);
    expect(report.sessions.total).toBe(1);
    const onDisk = await readRollupFile(filePath);
    expect(Object.keys(onDisk.sessions)).toEqual(["s2"]);
  });

  it("fork 复制过来的历史（早于会话创建时间）不计入", async () => {
    const { store } = fakeStore([
      session({
        id: "fork",
        createdAt: new Date(2026, 8, 24, 10).getTime(),
        updatedAt: new Date(2026, 8, 24, 11).getTime(),
        samples: [
          // 父会话复制过来的老条目
          sample({ at: new Date(2026, 8, 20, 9).getTime(), outputTokens: 999 }),
          // 分叉之后自己跑出来的
          sample({ at: new Date(2026, 8, 24, 10, 30).getTime(), outputTokens: 2 }),
        ],
      }),
    ]);
    const report = await createUsageStatsService({
      store,
      filePath: await tempFile(),
      now: () => NOW,
    }).report();
    expect(report.totalTokens).toBe(2);
  });

  it("会话列表读不到（空数组）且账本里已有数据时抛错，而不是给一份全 0 的报告", async () => {
    const filePath = await tempFile();
    const withSession = fakeStore([
      session({ id: "s1", updatedAt: 20, samples: [sample({ at: NOW })] }),
    ]);
    await createUsageStatsService({
      store: withSession.store,
      filePath,
      now: () => NOW,
    }).report();

    const empty = fakeStore([]);
    await expect(
      createUsageStatsService({ store: empty.store, filePath, now: () => NOW }).report(),
    ).rejects.toThrow(/会话列表/);
  });

  it("全新用户（没有会话、也没有账本）是一份空报告，不是错误", async () => {
    const service = createUsageStatsService({
      store: fakeStore([]).store,
      filePath: await tempFile(),
      now: () => NOW,
    });
    const report = await service.report();
    expect(report.totalTokens).toBe(0);
    expect(report.sessions.total).toBe(0);
    expect(report.scanning.active).toBe(false);
  });

  it("并发调用共用同一次折叠（不会把同一批样本算两遍）", async () => {
    const { store, calls } = fakeStore([
      session({ id: "s1", updatedAt: 20, samples: [sample({ at: NOW })] }),
    ]);
    const service = createUsageStatsService({ store, filePath: await tempFile(), now: () => NOW });
    const [first, second] = await Promise.all([service.report(), service.report()]);
    expect(calls).toHaveLength(1);
    expect(first.totalTokens).toBe(second.totalTokens);
  });

  it("落盘的账本带上版本号（将来改形状时据此重扫）", async () => {
    const filePath = await tempFile();
    const { store } = fakeStore([
      session({ id: "s1", updatedAt: 20, samples: [sample({ at: NOW })] }),
    ]);
    await createUsageStatsService({ store, filePath, now: () => NOW }).report();
    const onDisk = await readRollupFile(filePath);
    expect(onDisk.version).toBe(ROLLUP_VERSION);
    expect(onDisk.sessions.s1?.seenUpdatedAt).toBe(20);
  });
});
