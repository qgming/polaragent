// 插件的安装、卸载与开发挂载。
//
// ## `.ointplug` 就是一个 zip
//
// 用 zip 而不是自定义格式：一是跨平台工具链齐全（作者用什么都能打），
// 二是**解压那一道防线已经写好了**（main/storage/zip.ts，与技能包导入共用：
// 防 zip-slip、防 zip bomb、过滤元数据条目）。
//
// ## 安装顺序：先读懂，再落盘
//
// 先把 `plugin.json` 从压缩包里读出来校验，**再**决定装到哪、才解压。
// 反过来的话，一个恶意/损坏的包在"还没校验"的时候就已经写进磁盘了 ——
// 而那时的清理是"尽力而为"，不是设计。
//
// ## 目标目录名从插件 id 来，不从压缩包来
//
// 压缩包里的目录名是**外部输入**，而它要变成一个落盘路径。用 id（已由校验器
// 约束成反向域名）经 `pluginDirName` 归一，路径就只可能落在 `installed/` 之下。

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pluginDataDir, pluginDirName, pluginsDir } from "@/main/app/paths";
import { extractZipFile, readZipEntry, zipPrefixFor } from "@/main/storage/zip";
import { PLUGIN_MANIFEST_FILE } from "./discovery";
import { validatePluginManifest } from "./manifest";

export interface PluginInstallResult {
  pluginId: string;
  /** 落盘后的插件目录 */
  dir: string;
  /** 非致命的问题（清单里 Oint 不认识的根字段、跳过了解压条目等） */
  warnings: string[];
  /** 这次是覆盖了已有版本吗 */
  replaced: boolean;
}

/** 安装失败时抛出；`issues` 里是逐条可读原因 */
export class PluginInstallError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "PluginInstallError";
    this.issues = issues;
  }
}

/**
 * 从一个 `.ointplug`（zip）安装插件。
 *
 * 支持两种包内布局：清单在根，或在**唯一的一层子目录**里（"右键压缩文件夹"的产物）。
 * 后者极其常见，拒收它只会让每个作者都要学一遍"要把文件放在压缩包根"。
 */
export async function installPluginFromZip(
  zipPath: string,
  dataDir: string,
): Promise<PluginInstallResult> {
  // ── 先读懂 ────────────────────────────────────────────────────────────────

  const rawManifest = await readZipEntry(zipPath, PLUGIN_MANIFEST_FILE);
  if (rawManifest === undefined) {
    throw new PluginInstallError(`这个包里没有 ${PLUGIN_MANIFEST_FILE}（或有多层嵌套目录）`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest) as unknown;
  } catch (error) {
    throw new PluginInstallError(
      `${PLUGIN_MANIFEST_FILE} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = validatePluginManifest(parsed);
  if (!result.ok) {
    throw new PluginInstallError(
      `插件清单不合法（${result.issues.filter((issue) => issue.severity === "error").length} 处）`,
      result.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => `${issue.path}：${issue.message}`),
    );
  }
  const manifest = result.manifest;

  // ── 再落盘 ────────────────────────────────────────────────────────────────

  const installedRoot = path.join(pluginsDir(dataDir), "installed");
  const dirName = pluginDirName(manifest.id);
  const target = path.join(installedRoot, dirName);

  /*
    **先解压到临时目录，校验通过之后整体搬过去。**

    直接解到目标目录的话，中途失败（超限、磁盘满）会留下一个**半装的插件** ——
    而它下次启动时会被扫到，表现为"装了个坏插件"。用临时目录 + rename：
    rename 在同一卷上是原子的，于是"装上了"与"完整"是同一件事。
  */
  await mkdir(installedRoot, { recursive: true });
  const staging = path.join(pluginsDir(dataDir), `.staging-${dirName}-${Date.now()}`);
  // 子目录布局：剥掉那一层前缀，两种布局落盘后结构一致
  const prefix = await zipPrefixFor(zipPath, PLUGIN_MANIFEST_FILE);

  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    /*
      **解压到 staging 本身，不加前缀。**
      zip 里的条目名**已经含前缀**（`my-plugin/plugin.json`），所以解压到
      `staging/my-plugin` 会让文件落到 `staging/my-plugin/my-plugin/plugin.json`。
      前缀的作用是"搬走时从哪一层开始"，不是"解压到哪一层"。
    */
    const extracted = await extractZipFile(zipPath, staging);

    if (extracted.files === 0) {
      throw new PluginInstallError("压缩包里没有可安装的文件");
    }
    // 落盘之后**再验一次**清单在不在 —— 解压可能因为超限提前停了
    const landed = await readFile(path.join(staging, prefix, PLUGIN_MANIFEST_FILE), "utf8").catch(
      () => undefined,
    );
    if (landed === undefined) {
      throw new PluginInstallError(
        `解压后没有找到 ${PLUGIN_MANIFEST_FILE}（压缩包可能过大或已损坏）`,
      );
    }

    // 把剥离前缀后的内容搬到目标：子目录布局下 staging/<prefix>/ 才是插件根
    const source = prefix === "" ? staging : path.join(staging, prefix);
    const replaced = await pathExists(target);
    if (replaced) {
      /*
        覆盖安装（升级）：先删旧的。
        **调用方要先停用这个插件** —— 一个正在跑的进程的工具指向的是旧文件。
        （IPC 层做这件事，因为"停用"要动注册表与贡献面。）
      */
      await rm(target, { recursive: true, force: true });
    }
    await rename(source, target);

    return {
      pluginId: manifest.id,
      dir: target,
      replaced,
      warnings: [
        ...result.warnings.map((issue) => `${issue.path}：${issue.message}`),
        ...extracted.diagnostics,
      ],
    };
  } finally {
    // 无论成败都清掉暂存目录：留下的话下次安装会被 `.staging-` 前缀的目录干扰
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 卸载一个插件。
 *
 * `keepData` 决定插件私有数据目录的去留 —— 问用户"要不要保留数据"比替他决定好：
 * 一个记着几十个仓库路径的插件，重装之后发现全没了是很糟的体验。
 */
export async function uninstallPlugin(
  source: { id: string; dir: string },
  dataDir: string,
  keepData: boolean,
): Promise<void> {
  await rm(source.dir, { recursive: true, force: true });
  if (keepData) return;
  await rm(pluginDataDir(source.id, dataDir), { recursive: true, force: true }).catch(
    () => undefined,
  );
}

/** 开发插件清单文件（与 discovery.ts 的 DEV_PLUGINS_FILE 是同一个） */
const DEV_FILE = "dev.json";

/**
 * 把一个本地目录挂成开发插件。
 *
 * 与安装的区别是**不拷贝文件**：开发插件就是"直接引用那个目录"，
 * 于是保存即生效（配合文件监视）。代价是这个目录不能被删/移，
 * 而那正是"开发期"可以接受的假设。
 */
export async function addDevPlugin(pluginDir: string, dataDir: string): Promise<string> {
  const raw = await readFile(path.join(pluginDir, PLUGIN_MANIFEST_FILE), "utf8").catch(
    () => undefined,
  );
  if (raw === undefined) {
    throw new PluginInstallError(`选中的目录里没有 ${PLUGIN_MANIFEST_FILE}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new PluginInstallError(
      `${PLUGIN_MANIFEST_FILE} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = validatePluginManifest(parsed);
  if (!result.ok) {
    throw new PluginInstallError(
      "插件清单不合法",
      result.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => `${issue.path}：${issue.message}`),
    );
  }

  const absolute = path.resolve(pluginDir);
  const list = await readDevList(dataDir);
  if (!list.includes(absolute)) list.push(absolute);
  await writeDevList(dataDir, list);
  return result.manifest.id;
}

/** 解除一个开发插件的挂载（**不删目录**：那是用户自己的代码） */
export async function removeDevPlugin(pluginDir: string, dataDir: string): Promise<void> {
  const absolute = path.resolve(pluginDir);
  const list = await readDevList(dataDir);
  await writeDevList(
    dataDir,
    list.filter((entry) => entry !== absolute),
  );
}

async function readDevList(dataDir: string): Promise<string[]> {
  const raw = await readFile(path.join(pluginsDir(dataDir), DEV_FILE), "utf8").catch(
    () => undefined,
  );
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry !== "")
      : [];
  } catch {
    return [];
  }
}

async function writeDevList(dataDir: string, list: string[]): Promise<void> {
  const dir = pluginsDir(dataDir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, DEV_FILE), `${JSON.stringify(list, null, 2)}\n`, "utf8");
}

async function pathExists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => undefined)) !== undefined;
}
