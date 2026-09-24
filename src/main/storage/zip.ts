// 安全的 zip 解压：把外部压缩包落到一个目标目录里。
//
// 从 skills/zip-import.ts 抽出来的 —— 那里的机制（防 zip-slip、防 zip bomb、
// 过滤元数据条目）**与"技能"没有任何关系**，而插件安装要用同一套。
// 复制一份的话，两处的上限会开始漂移，而安全边界上的漂移不会有任何报错。
//
// ## 安全边界（导入的是外部文件，按不可信输入处理）
//
//  - **防 zip-slip**：拒绝绝对路径、盘符与含 `..` 的条目，落盘前**再**校验一次
//    目标路径在目标目录内（两道，因为第一道是字符串判断、第二道是解析后的判断）；
//  - **限流**：压缩包大小、解压总字节、条目数三道上限，避免 zip bomb 把内存/磁盘打满；
//  - **过滤垃圾条目**：目录条目与 macOS/Windows 的元数据文件。
//
// ## 它不保证的事（调用方要自己判）
//
//  - **不校验内容**：解压出来的东西是不是一个合法的插件/技能，由调用方在解压后判；
//  - **不清空目标目录**：它只写文件。要"干净安装"的话，调用方先解压到临时目录再整体搬。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";

/** 压缩包本体上限：超过就不读进内存 */
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
/** 解压后写入的总字节上限（zip bomb 兜底） */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** 条目数上限 */
const MAX_ENTRIES = 1000;

export interface ZipExtractResult {
  /** 实际写入磁盘的文件数 */
  files: number;
  /** 跳过/失败说明（路径越界、超限等），直接显示给用户 */
  diagnostics: string[];
}

/** 需要跳过的系统元数据文件（zip 里常见，不是内容） */
const JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** 把 zip 条目路径规整成安全的相对路径；不安全或应跳过时返回原因 */
function safeRelativePath(raw: string): { rel: string } | { skip: string } {
  // zip 规范用 /，但手工打包的工具可能写 \：统一后再切分
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.endsWith("/")) return { skip: "目录条目" };
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return { skip: "绝对路径" };
  }
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return { skip: "空路径" };
  if (segments.includes("..")) return { skip: "越界路径（..）" };
  if (segments[0] === "__MACOSX") return { skip: "macOS 元数据" };
  const base = segments[segments.length - 1] ?? "";
  if (JUNK_FILES.has(base)) return { skip: "系统元数据文件" };
  return { rel: segments.join("/") };
}

/** 从内存里的 zip 解压到 targetDir */
export async function extractZipBytes(
  archive: Uint8Array,
  targetDir: string,
): Promise<ZipExtractResult> {
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `压缩包过大（${Math.round(archive.byteLength / 1024 / 1024)} MB，上限 ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB）`,
    );
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archive);
  } catch (error) {
    throw new Error(
      `不是有效的 zip 压缩包：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const root = path.resolve(targetDir);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  const diagnostics: string[] = [];
  let files = 0;
  let totalBytes = 0;
  let skipped = 0;

  for (const [entryPath, data] of Object.entries(entries)) {
    if (files >= MAX_ENTRIES) {
      diagnostics.push(`条目过多，已停止导入（上限 ${MAX_ENTRIES} 个文件）`);
      break;
    }
    const parsed = safeRelativePath(entryPath);
    if ("skip" in parsed) {
      skipped += 1;
      // 目录条目单独统计没有意义：只有真正可疑的跳过才值得写进诊断
      if (parsed.skip !== "目录条目") diagnostics.push(`跳过 ${entryPath}：${parsed.skip}`);
      continue;
    }
    totalBytes += data.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      diagnostics.push(`解压后体积超过上限（${MAX_TOTAL_BYTES / 1024 / 1024} MB），已停止导入`);
      break;
    }
    const target = path.resolve(root, ...parsed.rel.split("/"));
    if (!target.startsWith(rootPrefix)) {
      // safeRelativePath 已经拦了，这里是落盘前的最后一道
      diagnostics.push(`跳过 ${entryPath}：目标路径在目标目录之外`);
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    files += 1;
  }

  if (skipped > 0 && files === 0) {
    diagnostics.push("压缩包里没有可导入的文件");
  }
  return { files, diagnostics };
}

/** 从一个 zip 文件解压到 targetDir */
export async function extractZipFile(
  zipPath: string,
  targetDir: string,
): Promise<ZipExtractResult> {
  return extractZipBytes(new Uint8Array(await readFile(zipPath)), targetDir);
}

/**
 * 读一个 zip 里**根级**的某个文件，不解压到磁盘。
 *
 * 插件安装要先用它读 `plugin.json` 判"这是一个什么插件"，再决定装到哪个目录 ——
 * 先解压再判的话，一个恶意包在"还没校验"的时候就已经写进磁盘了。
 */
export async function readZipEntry(
  zipPath: string,
  entryName: string,
): Promise<string | undefined> {
  const archive = new Uint8Array(await readFile(zipPath));
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archive);
  } catch {
    return undefined;
  }
  /*
    认两种布局：清单在根（`plugin.json`），或者在**唯一的一层子目录**里
    （`my-plugin/plugin.json`）。
    后者是"右键压缩一个文件夹"的产物 —— 作者十有八九是那么打包的，
    而拒收它只会让每个人都要学一遍"要把文件放在压缩包根"。
  */
  const direct = entries[entryName];
  if (direct !== undefined) {
    return new TextDecoder().decode(direct);
  }
  const nested = Object.entries(entries).filter(([name]) => name.endsWith(`/${entryName}`));
  if (nested.length !== 1) return undefined;
  const data = nested[0]?.[1];
  return data === undefined ? undefined : new TextDecoder().decode(data);
}

/**
 * 压缩包里清单所在的**目录前缀**（`""` 或 `"my-plugin/"`）。
 *
 * 与 readZipEntry 的两种布局对应。安装时按它剥掉前缀，于是两种布局落盘后的
 * 目录结构一致 —— 否则"子目录布局"的插件装完之后，`skills/` 会躺在
 * `<插件目录>/my-plugin/skills/`，而宿主按 `<插件目录>/skills/` 找。
 */
export async function zipPrefixFor(zipPath: string, entryName: string): Promise<string> {
  const archive = new Uint8Array(await readFile(zipPath));
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archive);
  } catch {
    return "";
  }
  if (entries[entryName] !== undefined) return "";
  const nested = Object.keys(entries).filter((name) => name.endsWith(`/${entryName}`));
  if (nested.length !== 1) return "";
  return `${nested[0]?.slice(0, -(entryName.length + 1)) ?? ""}`;
}
