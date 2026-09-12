// 应用自身的清单信息（显示名与版本）——一律以应用根目录的 package.json 为准。
//
// 为什么不直接用 Electron 的 app.getName() / app.getVersion()：
// 这两个 API 在**解析不到应用 package.json 时，会回退成 Electron 自身的名字/版本**
// （"Electron" / "44.3.0"）。dev 启动方式、打包布局或 appPath 一旦变化，界面就会安静地
// 显示一个**看起来完全合理的错数字**，没有任何报错可循。
// 这里显式读 package.json：读不到就返回 null，由界面留空 —— 与本仓 kernel-deps 同一口径：
// 「版本读不到时留空，不编造」。
//
// 刻意不 import electron：调用方传入 appPath，单测可以直接喂临时目录。

import { readFile } from "node:fs/promises";
import path from "node:path";

/** 文件读取注入点（默认 node:fs/promises 的 readFile） */
export type ManifestFileReader = (file: string) => Promise<string>;

export interface AppManifest {
  /** 显示名：productName 优先，其次 name；读不到时为 null */
  name: string | null;
  /** package.json 的 version，原样透出（含 -beta.1 这类后缀）；读不到时为 null */
  version: string | null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** 读取应用根目录的 package.json；文件读不到、JSON 非法或不是对象时返回全 null */
export async function readAppManifest(
  appPath: string,
  read: ManifestFileReader = (file) => readFile(file, "utf8"),
): Promise<AppManifest> {
  try {
    const parsed: unknown = JSON.parse(await read(path.join(appPath, "package.json")));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { name: null, version: null };
    }
    const manifest = parsed as Record<string, unknown>;
    return {
      name: asNonEmptyString(manifest.productName) ?? asNonEmptyString(manifest.name),
      version: asNonEmptyString(manifest.version),
    };
  } catch {
    return { name: null, version: null };
  }
}
