// 把一个插件目录打成 zip —— 「分享」的实现。
//
// ## 为什么分享的是 zip 而不是别的
//
// 因为**安装那边收的就是 zip**（`.ointplug`，见 install.ts）。导出与导入用同一种
// 容器，用户的路径才是闭合的：他把你给的包存下来，直接就能装。
// 用别的格式（tar、自定义包）就会需要两条解析路径，而其中一条必然缺少测试。
//
// ## 打包时剥不剥外层目录
//
// **不剥**：条目名是 `<插件目录名>/plugin.json`，也正是"右键压缩一个文件夹"的产物。
// 安装那边两种布局都认（见 zip.ts 的 readZipEntry），所以这不影响可用性；
// 而保留外层目录的好处是**解压出来不会散落一地**。
//
// ## 排除什么
//
// `node_modules` 与 `.git` 不打包：前者动辄几万个小文件（会让 zip 大到没法分享，
// 而它本来该由 `npm install` 还原），后者是作者的版本库、与插件本身无关。
// 剩下的一律打包 —— **不按扩展名白名单过滤**，因为插件可以带任何资源
//（图标、wasm、模板），白名单漏掉一种就是一个"分享出去少了个文件"的怪 bug。

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";

/** 不打包的目录名 */
const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".DS_Store"]);

/** 单个文件的大小上限：超过就跳过并记一条（分享包不该有几百 MB 的文件） */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** 条目总数上限（与解压那边同一量级；一个插件正常是几十个文件） */
const MAX_ENTRIES = 2000;

export interface PluginExportResult {
  /** zip 的字节 */
  archive: Uint8Array;
  /** 打进去的文件数 */
  files: number;
  /** 跳过的东西（给用户看的；空数组表示全都打进去了） */
  skipped: string[];
}

/**
 * 把一个插件目录打成 zip。
 *
 * @param rootDir 插件根目录（里面有 plugin.json）
 * @param rootName zip 里的顶层目录名（通常是插件目录的最后一段）
 */
export async function exportPluginZip(
  rootDir: string,
  rootName: string,
): Promise<PluginExportResult> {
  const entries: Record<string, Uint8Array> = {};
  const skipped: string[] = [];
  let files = 0;

  async function walk(dir: string, prefix: string): Promise<void> {
    const children = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (files >= MAX_ENTRIES) {
        skipped.push(`条目过多，已停止（上限 ${MAX_ENTRIES} 个文件）`);
        return;
      }
      if (child.isDirectory()) {
        if (EXCLUDED_DIRS.has(child.name)) {
          skipped.push(`${prefix}${child.name}/（不打包依赖与版本库）`);
          continue;
        }
        await walk(path.join(dir, child.name), `${prefix}${child.name}/`);
        continue;
      }
      if (!child.isFile()) {
        // 符号链接等：**不跟随**。跟着出去会把插件目录外的文件打进分享包，
        // 而接收方完全看不出那件事
        skipped.push(`${prefix}${child.name}（不是普通文件）`);
        continue;
      }

      const full = path.join(dir, child.name);
      const info = await stat(full).catch(() => undefined);
      if (info === undefined) continue;
      if (info.size > MAX_FILE_BYTES) {
        skipped.push(`${prefix}${child.name}（超过 ${MAX_FILE_BYTES / 1024 / 1024} MB）`);
        continue;
      }
      entries[`${rootName}/${prefix}${child.name}`] = new Uint8Array(await readFile(full));
      files += 1;
    }
  }

  await walk(rootDir, "");
  /*
    `level: 6` 是默认值附近的折中：分享包通常要过一次聊天软件，
    压缩率比打包速度更值钱一点点，但没必要上 9（那会让大插件卡住几秒）。
  */
  return { archive: zipSync(entries, { level: 6 }), files, skipped };
}
