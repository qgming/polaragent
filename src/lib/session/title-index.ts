// 会话标题索引：把侧边栏所需的「id / 标题 / 更新时间」集中存放，
// 避免为取这些信息而 open 整个 jsonl（会话越多越慢）。
// listSessions 只读这一个索引文件即可。
//
// 索引文件：<appData>/conversations/titles.json
//
// 维护时机：创建 / 重命名 / 删除 / 清空 会话时同步写入索引。
import { getSessionsRoot } from "./session-repo";
import { fileExists, readFile, writeFile } from "@/lib/electron/electron-api";

export interface TitleIndexEntry {
  title: string;
  updatedAt: number;
}

// 索引文件结构：id -> 索引项
type TitleIndex = Record<string, TitleIndexEntry>;

// 索引文件路径
async function getIndexPath(): Promise<string> {
  return `${await getSessionsRoot()}/titles.json`;
}

// 进程内缓存：避免侧边栏多次读盘；写入时同步更新
let cache: TitleIndex | null = null;

// 读取索引文件（不存在 / 解析失败均视为空索引）。结果进缓存。
export async function readTitleIndex(): Promise<TitleIndex> {
  if (cache) return cache;
  let index: TitleIndex;
  try {
    const path = await getIndexPath();
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
  cache = index;
  return index;
}

// 整体写回索引文件（覆盖写）。同步刷新缓存。
async function writeTitleIndex(index: TitleIndex): Promise<void> {
  cache = index;
  try {
    await writeFile(await getIndexPath(), JSON.stringify(index, null, 2));
  } catch (error) {
    console.error("写入会话标题索引失败:", error);
  }
}

// 更新（或新增）单条索引并落盘。title 缺省回退「新对话」。
export async function upsertTitleIndex(
  id: string,
  title: string,
  updatedAt: number,
): Promise<void> {
  const index = { ...(await readTitleIndex()) };
  index[id] = { title: title || "新对话", updatedAt };
  await writeTitleIndex(index);
}

// 删除单条索引并落盘。
export async function removeTitleIndex(id: string): Promise<void> {
  const index = { ...(await readTitleIndex()) };
  if (!(id in index)) return;
  delete index[id];
  await writeTitleIndex(index);
}

// 用「重建出的全量条目」整体覆盖索引（首次缺失时由 listSessions 调用）。
export async function rebuildTitleIndex(
  entries: Array<{ id: string; title: string; updatedAt: number }>,
): Promise<void> {
  const index: TitleIndex = {};
  for (const entry of entries) {
    index[entry.id] = {
      title: entry.title || "新对话",
      updatedAt: entry.updatedAt,
    };
  }
  await writeTitleIndex(index);
}

// 进程内重置缓存（数据目录变化时调用）。
export function resetTitleIndexCache(): void {
  cache = null;
}

// 校验解析结果形状，避免脏数据进缓存
function isValidIndex(value: unknown): value is TitleIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.title !== "string" || typeof e.updatedAt !== "number") return false;
  }
  return true;
}
