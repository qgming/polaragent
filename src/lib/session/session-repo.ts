// 会话仓库接线层：JsonlSessionRepo + ElectronExecutionEnv 的延迟初始化与共享状态。
import { JsonlSessionRepo, type Session } from "@earendil-works/pi-agent-core";
import { getDataDir } from "@/lib/electron/electron-api";
import { ElectronExecutionEnv } from "@/lib/electron/electron-fs";
import { resetTitleIndexCache } from "./title-index";

let envPromise: Promise<ElectronExecutionEnv> | null = null;
let repoPromise: Promise<JsonlSessionRepo> | null = null;
// 定时任务后台会话用独立 repo，根目录指向 <appData>/schedule/conversations
let scheduleRepoPromise: Promise<JsonlSessionRepo> | null = null;

// 同一 sessionId 的「打开/创建」结果缓存：复用同一个 Promise，
// 杜绝 createThread 与 createHarness 并发时各自 create 一次，导致同 id 产生两个 jsonl 文件。
// （这是「重启后出现两条同名会话、一条有标题一条空」的根因。）
export const sessionPromises = new Map<string, Promise<Session>>();

// 会话根目录：<appData>/conversations
export async function getSessionsRoot(): Promise<string> {
  const dataDir = (await getDataDir()).replace(/\\/g, "/").replace(/\/$/, "");
  return `${dataDir}/conversations`;
}

// 定时任务会话根目录：<appData>/schedule/conversations
export async function getScheduleSessionsRoot(): Promise<string> {
  const dataDir = (await getDataDir()).replace(/\\/g, "/").replace(/\/$/, "");
  return `${dataDir}/schedule/conversations`;
}

// 延迟初始化共享的 ExecutionEnv（cwd 指向会话根目录）
export async function getExecutionEnv(): Promise<ElectronExecutionEnv> {
  if (!envPromise) {
    envPromise = (async () => {
      const root = await getSessionsRoot();
      return new ElectronExecutionEnv(root);
    })();
  }
  return envPromise;
}

// 延迟初始化共享的 JsonlSessionRepo
export async function getRepo(): Promise<JsonlSessionRepo> {
  if (!repoPromise) {
    repoPromise = (async () => {
      const env = await getExecutionEnv();
      const sessionsRoot = await getSessionsRoot();
      // 确保根目录存在，避免首次 list/create 失败
      await env.createDir(sessionsRoot, { recursive: true });
      return new JsonlSessionRepo({ fs: env, sessionsRoot });
    })();
  }
  return repoPromise;
}

// 延迟初始化定时任务会话的 JsonlSessionRepo（根目录 = schedule/conversations）。
// 复用同一个 ExecutionEnv，仅通过独立 sessionsRoot 实现物理隔离。
export async function getScheduleRepo(): Promise<JsonlSessionRepo> {
  if (!scheduleRepoPromise) {
    scheduleRepoPromise = (async () => {
      const env = await getExecutionEnv();
      const sessionsRoot = await getScheduleSessionsRoot();
      await env.createDir(sessionsRoot, { recursive: true });
      return new JsonlSessionRepo({ fs: env, sessionsRoot });
    })();
  }
  return scheduleRepoPromise;
}

// 测试期重置（清空缓存的 env/repo），便于在数据目录变化后重建
export function resetSessionRuntime(): void {
  envPromise = null;
  repoPromise = null;
  scheduleRepoPromise = null;
  sessionPromises.clear();
  resetTitleIndexCache();
}
