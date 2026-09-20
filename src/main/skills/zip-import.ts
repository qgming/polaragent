// 技能包（zip）导入：把外部 .zip 解压到数据目录的 skills/ 下。
//
// 只做「解压落盘」，不解释技能格式：技能是否有效由内核的 loadSkills 在上层重新扫描时判定
//（见 ipc/skills.ts），这里返回文件数与诊断，让界面能说清「导入了多少、跳过了什么」。
//
// 安全边界（导入的是外部文件，按不可信输入处理）：
// - **防 zip-slip**：拒绝绝对路径、盘符与含 `..` 的条目，落盘前再校验一次目标路径在目标目录内；
// - **限流**：压缩包大小、解压总字节、条目数三道上限，避免 zip bomb 把内存/磁盘打满；
// - **过滤垃圾条目**：目录条目（以 / 结尾）与 macOS/Windows 的元数据文件（__MACOSX、.DS_Store 等）跳过。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";

/** 压缩包本体上限：超过就不读进内存 */
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
/** 解压后写入的总字节上限（zip bomb 兜底） */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** 条目数上限 */
const MAX_ENTRIES = 1000;

export interface SkillZipExtractResult {
  /** 实际写入磁盘的文件数 */
  files: number;
  /** 跳过/失败说明（路径越界、超限等），直接显示给用户 */
  diagnostics: string[];
}

/** 需要跳过的系统元数据文件（zip 里常见，不是技能内容） */
const JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** 把 zip 条目路径规整成安全的相对路径；不安全或应跳过时返回 null 并给出原因 */
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

/**
 * 解压一个技能包到 targetDir（通常是 `${dataDir()}/skills`）。
 *
 * 条目按 zip 顺序写入并**覆盖**同名文件：导入是用户主动动作，覆盖是可预期的语义；
 * 中途遇到超限就停止并留下说明，已经写入的部分保留（不清空目录 —— 那是删除技能的职责）。
 */
export async function extractSkillZip(
  zipPath: string,
  targetDir: string,
): Promise<SkillZipExtractResult> {
  const diagnostics: string[] = [];
  const archive = await readFile(zipPath);
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `压缩包过大（${Math.round(archive.byteLength / 1024 / 1024)} MB，上限 ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB）`,
    );
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(archive));
  } catch (error) {
    throw new Error(
      `不是有效的 zip 压缩包：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const root = path.resolve(targetDir);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
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
      diagnostics.push(`跳过 ${entryPath}：目标路径在技能目录之外`);
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
