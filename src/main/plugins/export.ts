import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";

const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".DS_Store"]);

const MAX_FILE_BYTES = 32 * 1024 * 1024;

const MAX_ENTRIES = 2000;

export interface PluginExportResult {
  archive: Uint8Array;

  files: number;

  skipped: string[];
}

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

  return { archive: zipSync(entries, { level: 6 }), files, skipped };
}
