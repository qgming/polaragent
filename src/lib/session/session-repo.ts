// 会话仓库接线层：JsonlSessionRepo + ElectronExecutionEnv 的延迟初始化与共享状态。
// 普通会话与团队会话各用一个 repo（物理隔离），共享同一个 ExecutionEnv。
import { JsonlSessionRepo, type Session } from "@earendil-works/pi-agent-core";
import { getDataDir } from "@/lib/electron/electron-api";
import { ElectronExecutionEnv } from "@/lib/electron/electron-fs";

let envPromise: Promise<ElectronExecutionEnv> | null = null;
let repoPromise: Promise<JsonlSessionRepo> | null = null;
// 团队会话用独立的 repo，根目录指向 <appData>/teams/conversations，与普通对话物理隔离
let teamRepoPromise: Promise<JsonlSessionRepo> | null = null;

// 同一 sessionId 的「打开/创建」结果缓存：复用同一个 Promise，
// 杜绝 createThread 与 createHarness 并发时各自 create 一次，导致同 id 产生两个 jsonl 文件。
// （这是「重启后出现两条同名会话、一条有标题一条空」的根因。）
export const sessionPromises = new Map<string, Promise<Session>>();

// 会话根目录：<appData>/conversations
export async function getSessionsRoot(): Promise<string> {
  const dataDir = (await getDataDir()).replace(/\\/g, "/").replace(/\/$/, "");
  return `${dataDir}/conversations`;
}

// 团队会话根目录：<appData>/teams/conversations
export async function getTeamSessionsRoot(): Promise<string> {
  const dataDir = (await getDataDir()).replace(/\\/g, "/").replace(/\/$/, "");
  return `${dataDir}/teams/conversations`;
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

// 延迟初始化团队会话的 JsonlSessionRepo（根目录 = teams/conversations）。
// 复用同一个 ExecutionEnv（其 cwd 指向普通会话根，仅用于 fs 操作，不影响团队 repo 的 sessionsRoot）。
export async function getTeamRepo(): Promise<JsonlSessionRepo> {
  if (!teamRepoPromise) {
    teamRepoPromise = (async () => {
      const env = await getExecutionEnv();
      const sessionsRoot = await getTeamSessionsRoot();
      await env.createDir(sessionsRoot, { recursive: true });
      return new JsonlSessionRepo({ fs: env, sessionsRoot });
    })();
  }
  return teamRepoPromise;
}

// 测试期重置（清空缓存的 env/repo），便于在数据目录变化后重建
export function resetSessionRuntime(): void {
  envPromise = null;
  repoPromise = null;
  teamRepoPromise = null;
  sessionPromises.clear();
}
