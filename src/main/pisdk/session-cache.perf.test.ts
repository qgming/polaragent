// P2-1 会话列表缓存的效果度量。
//
// `repo.list()` 对**每个会话文件**做 readdir → realpath → open → query → close，
// 底层是同步 `node:sqlite` —— 本机 50 个会话实测每次约 220 ms 的主进程阻塞，
// 而它原本在「列会话 / 打开会话 / 删会话 / fork」以及发送路径上都会被调到。
//
// 这个文件做两件事：
//   1. **不变量**：重复 list 只扫盘一次（缓存语义，与机器性能无关，作为断言）；
//   2. **实测数字**：打印首次与再次的耗时差异（只打印，不设阈值 ——
//      阈值随机器与数据量漂移，写死只会变成假红）。
//
// 数据目录是临时目录里造出来的（不读 ~/.oint）：CI 与干净机器上都要能跑。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import {
  createNodeSqliteFactory,
  SqliteSessionRepo,
} from "@earendil-works/pi-session-backend-sqlite-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionStore } from "./session-store";

/** 造多少个会话：够让「每文件一次同步 open」的成本显形 */
const SESSION_COUNT = 40;

let baseDir: string;

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), "oint-cache-perf-"));
  const repo = new SqliteSessionRepo({
    directory: path.join(baseDir, "sessions"),
    databaseFactory: createNodeSqliteFactory(),
  });
  const seed = createSessionStore(baseDir, repo);
  for (let index = 0; index < SESSION_COUNT; index += 1) {
    await seed.create({ title: `会话 ${index}`, cwd: baseDir });
  }
  await repo.close(BACKGROUND_CONTEXT);
  // 索引文件必须存在：list() 会读它
  await writeFile(path.join(baseDir, "sessions-index.json"), "{}\n", "utf8");
});

afterAll(async () => {
  /**
   * `maxRetries` / `retryDelay` 是**为 Windows 准备的**。
   *
   * SQLite 的 `-wal` / `-shm` 文件在后端刚关闭的那一刻还可能被句柄短暂占着，
   * 于是递归删除拿到 `EBUSY`；而 `force: true` 只忽略 ENOENT，**不忽略 EBUSY**。
   *
   * 症状：全量跑时这个文件偶发失败、单独跑必过（并发几十个 worker 时更容易撞上），
   * 报错是一句与断言无关的 `EBUSY: resource busy or locked, unlink ...sqlite-wal`。
   * Node 就是为这种场景提供这两个选项的（遇到 EBUSY/EPERM/ENOTEMPTY 时线性退避重试）。
   */
  await rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("P2-1 会话列表缓存的效果", () => {
  it("重复 list 不再扫盘（并打印实测耗时）", async () => {
    const repo = new SqliteSessionRepo({
      directory: path.join(baseDir, "sessions"),
      databaseFactory: createNodeSqliteFactory(),
    });
    const store = createSessionStore(baseDir, repo);

    let calls = 0;
    const original = repo.list.bind(repo);
    repo.list = ((...args: Parameters<typeof original>) => {
      calls += 1;
      return original(...args);
    }) as typeof repo.list;

    const first = performance.now();
    const list = await store.list();
    const firstMs = performance.now() - first;

    const second = performance.now();
    await store.list();
    const secondMs = performance.now() - second;

    console.log(
      `会话数 ${list.length} ｜ 首次 list ${firstMs.toFixed(1)} ms（扫盘 ${calls} 次）｜ ` +
        `再次 list ${secondMs.toFixed(1)} ms（累计扫盘 ${calls} 次）`,
    );

    // 只钉住「扫盘次数」这一条不变量：它是缓存语义，与机器性能无关
    expect(list).toHaveLength(SESSION_COUNT);
    expect(calls).toBe(1);
    await repo.close(BACKGROUND_CONTEXT);
  });
});
