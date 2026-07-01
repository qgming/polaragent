// 会话标题索引：把侧边栏所需的「id / 标题 / 更新时间 (+团队归属 teamId)」集中存放，
// 避免为取这些信息而 open 整个 jsonl（会话越多越慢）。listSessions / listTeamSessions
// 只读这一个索引文件即可，彻底去掉 N 次（团队是 2N 次）全文件读盘。
//
// 普通会话索引：<appData>/conversations/titles.json        （无 teamId）
// 团队会话索引：<appData>/teams/conversations/titles.json  （带 teamId）
// 两者复用同一套读写逻辑，按 kind 区分文件路径与进程内缓存，物理隔离。
//
// 维护时机：创建 / 重命名 / 删除 / 清空 会话时同步写入索引
// （普通见 conversation-store，团队见 team-chat-store / clearTeamSessions）。
// 首次启动若索引缺失（老用户），由 listSessions / listTeamSessions 回退旧逻辑
// （逐个 open 读 name）重建一次；此后即走快路径。
import { getSessionsRoot, getTeamSessionsRoot } from "./session-repo";
import { fileExists, readFile, writeFile } from "@/lib/electron/electron-api";

// 索引种类：普通对话 / 团队会话
export type TitleIndexKind = "normal" | "team";

// 单条索引项（teamId 仅团队索引使用）
export interface TitleIndexEntry {
  title: string;
  updatedAt: number;
  teamId?: string;
  projectId?: string;
}

// 索引文件结构：id -> 索引项
type TitleIndex = Record<string, TitleIndexEntry>;

// 各 kind 的索引文件路径
async function getIndexPath(kind: TitleIndexKind): Promise<string> {
  const root = kind === "team" ? await getTeamSessionsRoot() : await getSessionsRoot();
  return `${root}/titles.json`;
}

// 进程内缓存：按 kind 分开，避免侧边栏多次读盘；写入时同步更新
const caches: Record<TitleIndexKind, TitleIndex | null> = {
  normal: null,
  team: null,
};

// 读取索引文件（不存在 / 解析失败均视为空索引）。结果进缓存。
export async function readTitleIndex(kind: TitleIndexKind = "normal"): Promise<TitleIndex> {
  const cached = caches[kind];
  if (cached) return cached;
  let index: TitleIndex;
  try {
    const path = await getIndexPath(kind);
    // 先判存在：首次启动索引文件尚未生成，直接当空索引，
    // 避免对不存在的文件发起注定 ENOENT 的读取（会污染主进程控制台）。
    if (await fileExists(path)) {
      const parsed = JSON.parse(await readFile(path)) as unknown;
      index = isValidIndex(parsed) ? parsed : {};
    } else {
      index = {};
    }
  } catch {
    // 解析失败等异常：当作空索引，由调用方决定是否重建
    index = {};
  }
  caches[kind] = index;
  return index;
}

// 整体写回索引文件（覆盖写）。同步刷新缓存。
async function writeTitleIndex(kind: TitleIndexKind, index: TitleIndex): Promise<void> {
  caches[kind] = index;
  try {
    await writeFile(await getIndexPath(kind), JSON.stringify(index, null, 2));
  } catch (error) {
    console.error("写入会话标题索引失败:", error);
  }
}

// 更新（或新增）单条索引并落盘。title 缺省回退「新对话」。
// extra.teamId 仅团队索引传入；undefined 不会覆盖已有 teamId（保留原归属）。
export async function upsertTitleIndex(
  id: string,
  title: string,
  updatedAt: number,
  kind: TitleIndexKind = "normal",
  extra?: { teamId?: string; projectId?: string },
): Promise<void> {
  const index = { ...(await readTitleIndex(kind)) };
  const prev = index[id];
  index[id] = {
    title: title || "新对话",
    updatedAt,
    teamId: extra?.teamId ?? prev?.teamId,
    projectId: extra?.projectId ?? prev?.projectId,
  };
  await writeTitleIndex(kind, index);
}

// 删除单条索引并落盘。
export async function removeTitleIndex(
  id: string,
  kind: TitleIndexKind = "normal",
): Promise<void> {
  const index = { ...(await readTitleIndex(kind)) };
  if (!(id in index)) return;
  delete index[id];
  await writeTitleIndex(kind, index);
}

// 用「重建出的全量条目」整体覆盖索引（首次缺失时由 list* 调用）。
export async function rebuildTitleIndex(
  entries: Array<{ id: string; title: string; updatedAt: number; teamId?: string; projectId?: string }>,
  kind: TitleIndexKind = "normal",
): Promise<void> {
  const index: TitleIndex = {};
  for (const entry of entries) {
    index[entry.id] = {
      title: entry.title || "新对话",
      updatedAt: entry.updatedAt,
      teamId: entry.teamId,
      projectId: entry.projectId,
    };
  }
  await writeTitleIndex(kind, index);
}

// 进程内重置缓存（数据目录变化时调用）。
export function resetTitleIndexCache(): void {
  caches.normal = null;
  caches.team = null;
}

// 校验解析结果形状，避免脏数据进缓存
function isValidIndex(value: unknown): value is TitleIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.title !== "string" || typeof e.updatedAt !== "number") return false;
    if (e.teamId !== undefined && typeof e.teamId !== "string") return false;
    if (e.projectId !== undefined && typeof e.projectId !== "string") return false;
  }
  return true;
}
