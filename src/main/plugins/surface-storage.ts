// 插件私有 KV 存储：`<dataDir>/plugins/data/<归一 id>/storage.json`。
//
// ## 为什么给一个 KV，而不是让插件直接写文件
//
// 因为"持久化一点状态"是几乎每个界面插件都要做的事（面板宽度、上次看的仓库、
// 折叠状态），而不给这条路的话，作者们会去申请 `fs.write` —— 一个 high 风险权限，
// 为了存 200 字节的偏好。**给一条窄路，比让所有人去走宽路要好。**
//
// ## 三条边界
//
//  1. **命名空间由宿主给**，不由参数传入（`pluginId` 来自归属表）——
//     插件之间因此不可能互相读到对方的键；
//  2. **单文件单插件**，所以"读到别人的"需要在路径上出问题，而路径由
//     `pluginDataDir()` 归一（见 paths.ts 的 pluginDirName：白名单字符之外全替换）；
//  3. **有大小上限**，且超限是**报错**而不是静默截断 —— 静默截断会让插件读到
//     自己写的半个值，那比写失败难查得多。

import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pluginDataDir } from "@/main/app/paths";
import { writeFileAtomic } from "@/main/storage/atomic-write";
import type { SurfaceStoredValue } from "@/shared/contracts/surface";

/**
 * 一个插件 KV 的总大小上限（字节，按序列化后的 JSON 算）。
 *
 * 1 MiB 是"够任何正常的界面偏好"与"填不满磁盘"之间的取舍点：
 * 存 200 个仓库路径、50 条历史记录都远在它之下。
 */
const MAX_BYTES = 1024 * 1024;

/** 键名长度上限 —— 防止用一个超长键把文件撑大 */
const MAX_KEY_LENGTH = 256;

interface StorageFile {
  version: 1;
  values: Record<string, SurfaceStoredValue>;
}

/**
 * 进程内缓存。
 *
 * `storage.json` 会被面板的每次状态变更读到（拖动、切换、滚动位置……），
 * 每次都读盘 + 解析在交互里是能感觉到的。缓存只在**本进程内**，
 * 而"用户手改这个文件"不是需要支持的场景（它是插件的私有数据）。
 */
const cache = new Map<string, StorageFile>();

function fileOf(pluginId: string): string {
  return path.join(pluginDataDir(pluginId), "storage.json");
}

async function load(pluginId: string): Promise<StorageFile> {
  const cached = cache.get(pluginId);
  if (cached !== undefined) return cached;

  let parsed: StorageFile = { version: 1, values: {} };
  try {
    const raw = JSON.parse(await readFile(fileOf(pluginId), "utf8")) as unknown;
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as StorageFile).values === "object" &&
      (raw as StorageFile).values !== null
    ) {
      parsed = { version: 1, values: (raw as StorageFile).values };
    }
  } catch {
    // 文件不存在（首次）或坏掉：都从空开始。
    // **坏掉时不抛错** —— 插件的数据坏了不该让它的界面整个打不开；
    // 从空开始是可恢复的，而报错会让用户面对一个再也开不了的界面。
  }
  cache.set(pluginId, parsed);
  return parsed;
}

async function persist(pluginId: string, file: StorageFile): Promise<void> {
  const payload = JSON.stringify(file, null, 2);
  if (Buffer.byteLength(payload, "utf8") > MAX_BYTES) {
    throw new Error(
      `插件存储超出上限（${MAX_BYTES} 字节）。请减少存的数据量，或改用插件的私有文件`,
    );
  }
  const target = fileOf(pluginId);
  /*
    先建目录：`pluginDataDir` 下的目录只在这个插件第一次写数据时才需要存在，
    而 `writeFileAtomic` 不建父目录（这一点在插件启停状态那里已经踩过一次）。
  */
  await mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomic(target, `${payload}\n`);
  cache.set(pluginId, file);
}

function checkKey(key: unknown): string {
  if (typeof key !== "string" || key === "") throw new Error("storage 的键必须是非空字符串");
  if (key.length > MAX_KEY_LENGTH) throw new Error(`storage 的键不能超过 ${MAX_KEY_LENGTH} 个字符`);
  return key;
}

/**
 * 值必须是**能 JSON 往返**的东西。
 *
 * 用 `JSON.stringify` 的实际行为判，而不是自己写一个类型检查：
 * 函数、Symbol、循环引用都会在这里现形，而 `undefined` 单独判
 *（`JSON.stringify(undefined)` 返回 `undefined` 而不是字符串，直接落盘会写坏文件）。
 */
function checkValue(value: unknown): SurfaceStoredValue {
  if (value === undefined) throw new Error("storage 的值不能是 undefined（要删除请用 delete）");
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("storage 的值必须是可序列化的 JSON（不能有循环引用）");
  }
  if (encoded === undefined) throw new Error("storage 的值必须是可序列化的 JSON");
  return value as SurfaceStoredValue;
}

export async function surfaceStorageGet(
  pluginId: string,
  key: string,
): Promise<SurfaceStoredValue | undefined> {
  return (await load(pluginId)).values[checkKey(key)];
}

export async function surfaceStorageSet(
  pluginId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const file = await load(pluginId);
  await persist(pluginId, {
    version: 1,
    values: { ...file.values, [checkKey(key)]: checkValue(value) },
  });
}

export async function surfaceStorageDelete(pluginId: string, key: string): Promise<void> {
  const file = await load(pluginId);
  const values = { ...file.values };
  delete values[checkKey(key)];
  await persist(pluginId, { version: 1, values });
}

export async function surfaceStorageKeys(pluginId: string): Promise<string[]> {
  return Object.keys((await load(pluginId)).values).sort();
}

/**
 * 丢掉某个插件的缓存与数据。
 *
 * `dropCache` 与"删文件"是**两件事**，所以分成两个参数：
 * 卸载插件时要连文件一起删；而"用户在插件管理里点了重载"只该丢缓存，
 * 让下一次读重新从盘上取。
 */
export async function clearSurfaceStorage(pluginId: string, dropFiles: boolean): Promise<void> {
  cache.delete(pluginId);
  if (!dropFiles) return;
  await rm(pluginDataDir(pluginId), { recursive: true, force: true }).catch(() => undefined);
}

/** 只给测试用：清掉进程内缓存，让下一次读重新走盘 */
export function resetSurfaceStorageCacheForTest(): void {
  cache.clear();
}
