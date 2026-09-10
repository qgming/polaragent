import { mkdirSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

/** 应用数据根目录：Electron 按平台解析（Windows 为 %APPDATA%/PolarAgent） */
export function dataDir(): string {
  return app.getPath("userData");
}

/** 启动时确保各子目录存在，后续写入无需再判空 */
export function ensureAppDirs(): void {
  for (const name of ["config", "sessions", "skills", "logs"]) {
    mkdirSync(path.join(dataDir(), name), { recursive: true });
  }
}
